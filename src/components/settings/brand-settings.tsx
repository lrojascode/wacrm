"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImagePlus, Loader2, MessageSquare, Sparkles, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  BRAND_BUCKET,
  BRAND_LOGO_SIZES,
  DEFAULT_BRAND_TITLE,
  LOGO_ACCEPT,
  LOGO_MIME,
  MAX_BRAND_NAME_LEN,
  MAX_LOGO_BYTES,
  normalizeBrandName,
  parseBrandAssetPath,
  type BrandDisplayMode,
  type BrandLogoSize,
} from "@/lib/branding/brand";
import {
  deleteAccountMedia,
  uploadAccountMedia,
} from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";
import { cn } from "@/lib/utils";

/**
 * Brand settings — the account's own name, logo, display mode, and logo size.
 */
export function BrandSettings() {
  const router = useRouter();
  const {
    accountId,
    account,
    isOwner,
    profileLoading,
    refreshProfile,
  } = useAuth();
  const t = useTranslations("Settings.brand");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const savedName = account?.brand_name ?? account?.name ?? "";
  const savedLogo = account?.logo_url ?? null;
  const savedDisplayMode: BrandDisplayMode =
    account?.brand_display_mode === "logo" ||
    account?.brand_display_mode === "text" ||
    account?.brand_display_mode === "both"
      ? account.brand_display_mode
      : "both";
  const savedLogoSize: BrandLogoSize =
    account?.brand_logo_size === "sm" ||
    account?.brand_logo_size === "md" ||
    account?.brand_logo_size === "lg"
      ? account.brand_logo_size
      : "sm";

  const [name, setName] = useState("");
  const [displayMode, setDisplayMode] = useState<BrandDisplayMode>("both");
  const [logoSize, setLogoSize] = useState<BrandLogoSize>("sm");
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed once profile resolves or saved values change
  useEffect(() => {
    setName(savedName);
    setDisplayMode(savedDisplayMode);
    setLogoSize(savedLogoSize);
    setPendingLogo(null);
    setPreviewUrl(null);
    setRemoveLogo(false);
  }, [savedName, savedLogo, savedDisplayMode, savedLogoSize]);

  // Release object URLs so a few logo previews don't leak files
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const shownLogo = previewUrl ?? (removeLogo ? null : savedLogo);
  const dirty =
    normalizeBrandName(name) !== normalizeBrandName(savedName) ||
    displayMode !== savedDisplayMode ||
    logoSize !== savedLogoSize ||
    pendingLogo !== null ||
    removeLogo;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!(LOGO_MIME as readonly string[]).includes(file.type)) {
      toast.error(t("unsupportedImage"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t("imageTooLarge"));
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveLogo(false);
  }

  function onRemoveLogo() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(null);
    setPreviewUrl(null);
    setRemoveLogo(true);
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);

    try {
      let nextLogoUrl = savedLogo;
      if (pendingLogo) {
        const { publicUrl } = await uploadAccountMedia(
          BRAND_BUCKET,
          pendingLogo,
        );
        nextLogoUrl = publicUrl;
      } else if (removeLogo) {
        nextLogoUrl = null;
      }

      const brandName = normalizeBrandName(name);

      const res = await fetch("/api/account/brand", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: brandName ?? savedName ?? "",
          logo_url: nextLogoUrl,
          brand_display_mode: displayMode,
          brand_logo_size: logoSize,
        }),
      });

      if (!res.ok) {
        toast.error(t("saveFailed"));
        setSaving(false);
        return;
      }

      if (savedLogo && savedLogo !== nextLogoUrl) {
        const stalePath = parseBrandAssetPath(savedLogo);
        if (stalePath) {
          void deleteAccountMedia(BRAND_BUCKET, stalePath).catch(() => {});
        }
      }

      await refreshProfile();
      router.refresh();
      toast.success(t("saveSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const previewConfig = BRAND_LOGO_SIZES[logoSize] || BRAND_LOGO_SIZES.sm;
  const previewTitle = name.trim() || DEFAULT_BRAND_TITLE;
  const showPreviewLogo = displayMode === "logo" || displayMode === "both";
  const showPreviewText = displayMode === "text" || displayMode === "both";

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Sparkles className="size-4 text-primary" />
            {t("identity")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("identityDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Logo */}
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("logo")}</Label>
            <div className="flex items-center gap-4">
              {shownLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shownLogo}
                  alt=""
                  className="size-12 shrink-0 rounded-lg border border-border object-contain"
                />
              ) : (
                <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
                  <ImagePlus className="size-5" />
                </div>
              )}
              {isOwner && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={LOGO_ACCEPT}
                    onChange={onPickFile}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={saving}
                  >
                    {shownLogo ? t("changeLogo") : t("uploadLogo")}
                  </Button>
                  {shownLogo && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={onRemoveLogo}
                      disabled={saving}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="size-4" />
                      {t("remove")}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("logoHint")}</p>
          </div>

          {/* Name */}
          <div className="grid gap-2 sm:max-w-sm">
            <Label className="text-muted-foreground" htmlFor="brand-name">
              {t("nameLabel")}
            </Label>
            <Input
              id="brand-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_BRAND_NAME_LEN}
              disabled={!isOwner || profileLoading || saving}
              placeholder={t("namePlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("nameDesc")}</p>
          </div>

          {/* Display Mode & Logo Size */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground" htmlFor="brand-display-mode">
                {t("displayMode")}
              </Label>
              <select
                id="brand-display-mode"
                value={displayMode}
                onChange={(e) => setDisplayMode(e.target.value as BrandDisplayMode)}
                disabled={!isOwner || profileLoading || saving}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="both">{t("displayModeBoth")}</option>
                <option value="logo">{t("displayModeLogo")}</option>
                <option value="text">{t("displayModeText")}</option>
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground" htmlFor="brand-logo-size">
                {t("logoSize")}
              </Label>
              <select
                id="brand-logo-size"
                value={logoSize}
                onChange={(e) => setLogoSize(e.target.value as BrandLogoSize)}
                disabled={!isOwner || profileLoading || saving}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="sm">{t("logoSizeSm")}</option>
                <option value="md">{t("logoSizeMd")}</option>
                <option value="lg">{t("logoSizeLg")}</option>
              </select>
            </div>
          </div>

          {/* Live Preview */}
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("preview")}</Label>
            <div className="w-60 rounded-xl border border-border bg-card p-2 shadow-sm">
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-background px-3 transition-all",
                  previewConfig.container,
                )}
              >
                {showPreviewLogo && (
                  shownLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={shownLogo}
                      alt=""
                      className={cn("shrink-0 rounded-lg object-contain", previewConfig.logo)}
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground",
                        previewConfig.logo,
                      )}
                    >
                      <MessageSquare className={previewConfig.icon} />
                    </div>
                  )
                )}
                {showPreviewText && (
                  <span className="truncate text-sm font-semibold text-foreground">
                    {previewTitle}
                  </span>
                )}
              </div>
            </div>
          </div>

          {!isOwner && (
            <p className="text-xs text-muted-foreground">
              {t("adminOnlyHint")}
            </p>
          )}

          {isOwner && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
