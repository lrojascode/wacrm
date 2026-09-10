import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image that has a URL but no handle yet.
 * Image-only for now (the #230 scope); video/document handles can follow
 * the same shape.
 *
 * ============================================================
 * P0-SEC-04 — why this fetch is guarded
 *
 * `header_media_url` is whatever the caller typed into the template
 * form, and the server is what fetches it. Unguarded, that is a
 * Server-Side Request Forgery primitive: `http://169.254.169.254/...`
 * reads cloud instance credentials, `http://10.0.0.x/` probes the
 * private network, and `http://localhost:54321/` reaches Supabase from
 * inside the trust boundary. The role check added in P0-SEC-01 narrows
 * *who* can aim it (admin and above) but does not make the request
 * safe — an admin of one tenant is not an operator of the host.
 *
 * The second half of the problem was memory: the old code called
 * `res.arrayBuffer()` and only then compared against the 5 MB limit,
 * so the limit was enforced by an allocation that had already
 * happened. A URL answering with 2 GB took the process down before
 * the check ran — a one-request denial of service.
 *
 * Four controls, in the order they apply:
 *   1. `https:` only, and `isDeliverableUrl` (the same guard the
 *      webhook sender uses) — rejects before any connection.
 *   2. Redirects followed by hand, re-validating every hop, so a
 *      public URL cannot 302 into the private network.
 *   3. `Content-Length` refused before the body is touched.
 *   4. The body read in chunks and abandoned the moment it crosses
 *      5 MB, so the cap bounds the allocation instead of describing it.
 *
 * Residual risk, unchanged and documented rather than papered over:
 * DNS rebinding. `isDeliverableUrl` resolves the host, but `fetch`
 * resolves it again and does not let us pin the address into the
 * socket, so a name that answers public here and private a moment
 * later still gets through. Closing it needs a custom agent.
 * ============================================================
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

/** Per-hop budget. The source is a CDN; slow is indistinguishable from hostile. */
const FETCH_TIMEOUT_MS = 10_000

/** Enough for the usual CDN canonicalisation, short of a redirect loop. */
const MAX_REDIRECTS = 3

/**
 * Thrown when the response outgrows the cap mid-read.
 *
 * Distinct from a plain Error because the caller cannot report the real
 * size any more: we stop reading, so the true length is never known.
 * That is the point of the change, and the message says the limit
 * rather than pretending to a measurement.
 */
class ImageTooLargeError extends Error {
  constructor() {
    super(`Header image is larger than Meta's 5 MB limit.`)
    this.name = 'ImageTooLargeError'
  }
}

/**
 * Resolve `raw` to a URL that is safe for the server to request, or
 * throw with a message the user can act on.
 *
 * Deliberately gives the same answer for "private address" and "does
 * not resolve": distinguishing them would turn the error into an
 * oracle for mapping the internal network.
 */
async function assertPubliclyFetchable(raw: string, what: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what} is not a valid URL.`)
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${what} must be an https:// URL (got ${url.protocol.replace(':', '')}).`)
  }

  if (!(await isDeliverableUrl(url.href))) {
    throw new Error(
      `${what} must point at a publicly reachable host. Private, local and internal addresses are refused.`,
    )
  }

  return url
}

/**
 * Read at most `max` bytes, abandoning the response as soon as it goes
 * over instead of buffering it whole and measuring afterwards.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      // Closes the socket; the rest of the payload is never allocated.
      await reader.cancel()
      throw new ImageTooLargeError()
    }
    chunks.push(value)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch `startUrl`, following redirects manually so that each hop is
 * re-validated. `redirect: 'manual'` is what makes that possible —
 * letting fetch follow them would hand an attacker a public first hop
 * and an internal second one.
 */
async function fetchFollowingValidatedRedirects(startUrl: URL): Promise<Response> {
  let current = startUrl

  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
    }

    const isRedirect = res.status >= 300 && res.status < 400
    if (!isRedirect) {
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`Header image URL returned ${res.status}. It must be publicly reachable.`)
      }
      return res
    }

    // A redirect body is never the image; release it before moving on.
    await res.body?.cancel()

    const location = res.headers.get('location')
    if (!location) {
      throw new Error(`Header image URL returned ${res.status} without a destination.`)
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Header image URL redirected more than ${MAX_REDIRECTS} times.`)
    }

    current = await assertPubliclyFetchable(
      new URL(location, current).href,
      'The header image redirect target',
    )
  }
}

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  // The account's own Meta app id (whatsapp_config.meta_app_id,
  // migration 044), when it has configured one. Falls back to the
  // deployment-wide META_APP_ID — same fallback semantics as the
  // webhook's app secret (src/lib/whatsapp/webhook-signature.ts):
  // NULL means "use the shared app", not "no app at all".
  appIdOverride?: string | null,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = appIdOverride ?? process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image-header templates need a Meta App ID — set META_APP_ID in your environment, or configure this account’s own Meta App in Settings → WhatsApp. Alternatively, remove the image header.',
    )
  }

  // Refuse the URL before opening any connection to it.
  const target = await assertPubliclyFetchable(payload.header_media_url, 'The header image URL')

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  const res = await fetchFollowingValidatedRedirects(target)

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    await res.body?.cancel()
    throw new Error(`Header image must be JPEG or PNG (got ${contentType}).`)
  }

  // Believe a declared oversize and hang up now — cheaper than reading
  // 5 MB to learn what the header already said. An absent or lying
  // Content-Length changes nothing: readCapped enforces the same limit.
  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES) {
    await res.body?.cancel()
    throw new ImageTooLargeError()
  }

  const bytes = await readCapped(res, IMAGE_MAX_BYTES)
  if (bytes.byteLength === 0) {
    throw new Error('Header image is empty.')
  }

  const mimeType = ALLOWED_IMAGE_TYPES.includes(contentType) ? contentType : 'image/jpeg'
  const fileName = mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
