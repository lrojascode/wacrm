// ============================================================
// DELETE /api/conversations/[id] — owner only.
//
// Irreversible: the conversation, its messages and reactions, and its
// notifications all go (FK CASCADE), and the images the team sent are
// removed from the `chat-media` bucket. Linked deals survive with a
// NULL conversation_id — see migration 045, which also tightens the
// `conversations_delete` RLS policy to owner. That policy is the real
// boundary, since the dashboard inbox writes to PostgREST directly
// from the browser; `requireRole` here is belt-and-braces so the API
// can't be used to route around it either.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const CHAT_MEDIA_BUCKET = 'chat-media'

/**
 * Map a stored `messages.media_url` back to an object path inside the
 * `chat-media` bucket, or null when it isn't one of ours to delete.
 *
 * Inbound media (`/api/whatsapp/media/<id>`) is proxied from Meta and
 * has no object in our Storage, so it's skipped. Anything whose first
 * path segment isn't this account's folder is skipped too: media_url
 * is free text, and a row carrying a doctored URL must not be able to
 * reach into another tenant's files.
 */
function toAccountObjectPath(
  mediaUrl: string,
  accountId: string,
): string | null {
  const marker = `/${CHAT_MEDIA_BUCKET}/`
  const at = mediaUrl.indexOf(marker)
  if (at === -1) return null

  const path = mediaUrl.slice(at + marker.length).split('?')[0]
  if (!path) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }

  if (decoded.split('/')[0] !== `account-${accountId}`) return null
  return decoded
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('owner')
    const { id } = await params

    const limit = checkRateLimit(
      `conversation:delete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    // Collect the attachments first — the rows are about to disappear
    // down the messages CASCADE, taking the only pointer to the files
    // with them.
    const { data: mediaRows, error: mediaErr } = await ctx.supabase
      .from('messages')
      .select('media_url')
      .eq('conversation_id', id)
      .not('media_url', 'is', null)

    if (mediaErr) {
      console.error('[DELETE /api/conversations/[id]] media lookup error:', mediaErr)
      return NextResponse.json(
        { error: 'Failed to delete conversation' },
        { status: 500 },
      )
    }

    const objectPaths = [
      ...new Set(
        (mediaRows ?? [])
          .map((row) => toAccountObjectPath(row.media_url as string, ctx.accountId))
          .filter((path): path is string => path !== null),
      ),
    ]

    const { error, count } = await ctx.supabase
      .from('conversations')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/conversations/[id]] delete error:', error)
      return NextResponse.json(
        { error: 'Failed to delete conversation' },
        { status: 500 },
      )
    }
    if (!count) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    // Storage cleanup is best-effort and deliberately last. The rows
    // are already gone, so a failure here leaves orphaned files, not a
    // half-deleted conversation — worth logging, not worth 500ing over.
    if (objectPaths.length > 0) {
      const { error: storageErr } = await ctx.supabase.storage
        .from(CHAT_MEDIA_BUCKET)
        .remove(objectPaths)

      if (storageErr) {
        console.error(
          '[DELETE /api/conversations/[id]] storage cleanup failed, files orphaned:',
          storageErr,
        )
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
