import { NextResponse } from 'next/server';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { withRoute } from '@/lib/auth/guard';

/**
 * Meta identifies media by an opaque id with no filename or extension, so
 * we synthesise one from the MIME type. Covers what WhatsApp actually
 * sends; anything else falls back to the subtype, which is close enough
 * for a save dialog (`audio/ogg` -> `.ogg`).
 */
function mediaFilename(mediaId: string, contentType: string): string {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
  };
  const subtype = mime.split('/')[1] ?? '';
  // Strip vendor/suffix noise (`application/vnd.ms-excel`, `image/svg+xml`).
  const fallback = subtype.split('+')[0].replace(/[^a-z0-9.]/g, '') || 'bin';
  const ext = known[mime] ?? fallback;
  // The id is Meta-generated and numeric in practice, but it lands in a
  // header — keep it to characters that can't break out of the quotes.
  const safeId = mediaId.replace(/[^A-Za-z0-9_-]/g, '') || 'media';
  return `${safeId}.${ext}`;
}

// `viewer`: this proxies media the inbox renders, and a viewer can read
// the inbox. The account scoping below is what keeps it to their own
// media.
export const GET = withRoute(
  { minRole: 'viewer' },
  async (
    ctx,
    request,
    { params }: { params: Promise<{ mediaId: string }> }
  ) => {
    const { supabase, accountId } = ctx;
    try {
      const { mediaId } = await params;

      if (!mediaId) {
        return NextResponse.json(
          { error: 'Media ID is required' },
          { status: 400 }
        );
      }

      // Fetch and decrypt WhatsApp config
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single();

      if (configError || !config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured' },
          { status: 400 }
        );
      }

      const accessToken = decrypt(config.access_token);

      // Get the download URL from Meta
      const mediaInfo = await getMediaUrl({ mediaId, accessToken });

      // Download the binary data
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: mediaInfo.url,
        accessToken,
      });

      const resolvedType =
        contentType || mediaInfo.mimeType || 'application/octet-stream';

      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': resolvedType,
          'Cache-Control': 'public, max-age=86400',
          // `inline` so the browser still renders it in the <img>, but the
          // filename is what "Save image as" pre-fills. Without it the save
          // dialog offers the bare media id with no extension.
          'Content-Disposition': `inline; filename="${mediaFilename(mediaId, resolvedType)}"`,
        },
      });
    } catch (error) {
      console.error('Error in WhatsApp media GET:', error);
      return NextResponse.json(
        { error: 'Failed to fetch media' },
        { status: 500 }
      );
    }
  }
);
