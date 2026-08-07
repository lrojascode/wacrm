"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

interface ImageLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Same URL the thumbnail uses — the full-size original either way. */
  url: string;
  alt: string;
}

/**
 * Turns a media URL into one the browser will actually save to disk.
 *
 * Two cases, and they behave differently:
 *  - Our own `/api/whatsapp/media/...` proxy is same-origin, so the plain
 *    `download` attribute is honoured (and the route already sends a
 *    `Content-Disposition` filename).
 *  - Supabase Storage public URLs are cross-origin, where browsers *ignore*
 *    `download` and just navigate to the image instead. Storage accepts a
 *    `?download=` param that makes it reply with `attachment`, which is the
 *    only thing that works there.
 */
function toDownloadUrl(url: string): string {
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes("/storage/v1/object/")) return url;
    const filename = parsed.pathname.split("/").pop() || "image";
    parsed.searchParams.set("download", filename);
    return parsed.toString();
  } catch {
    // Not a parseable absolute URL — leave it alone rather than mangle it.
    return url;
  }
}

export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
}: ImageLightboxProps) {
  const t = useTranslations("Inbox.bubble");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-auto max-w-[95vw] gap-2 bg-transparent p-0 ring-0 sm:max-w-[90vw]"
        showCloseButton={false}
      >
        {/* Base UI wires aria-labelledby to this; keep it for screen
         *  readers without putting a visible caption over the image. */}
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img
          src={url}
          alt={alt}
          className="max-h-[85vh] max-w-full rounded-lg object-contain"
        />
        {/* The panel is transparent, so the Dialog's own ghost close
         *  button would sit invisibly over the image corner. These two
         *  replace it. */}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            render={
              <a
                href={toDownloadUrl(url)}
                download
                // Storage's ?download= reply is an attachment, but Safari
                // still needs the anchor to not be treated as navigation.
                rel="noopener"
              />
            }
          >
            <Download className="size-4" />
            {t("download")}
          </Button>
          <DialogClose render={<Button variant="secondary" size="sm" />}>
            {t("close")}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
