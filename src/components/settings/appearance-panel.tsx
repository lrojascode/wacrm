"use client";

import { useState } from "react";
import { Check, Lock, Moon, Palette, SunMoon, Sun } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { MODES, THEMES, type Mode, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Appearance panel — light/dark mode + accent-color picker.
 *
 * Account-wide since migration 051: the owner's pick is what every
 * member's session converges to (see AccountThemeSync). The owner's
 * clicks here apply instantly to their own screen via `useTheme()`
 * AND persist to the account through PUT /api/account/appearance;
 * everyone else gets a read-only view of the current pick.
 */
export function AppearancePanel() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const { isOwner, refreshProfile } = useAuth();
  const t = useTranslations("Settings.appearance");
  const [saving, setSaving] = useState(false);

  async function persist(update: { theme?: ThemeId; mode?: Mode }) {
    setSaving(true);
    try {
      const res = await fetch("/api/account/appearance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        toast.error(t("saveError"));
        return;
      }
      await refreshProfile();
    } catch (err) {
      console.error("[AppearancePanel] save error:", err);
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  function pickMode(m: Mode) {
    setMode(m);
    void persist({ mode: m });
  }

  function pickTheme(id: ThemeId) {
    setTheme(id);
    void persist({ theme: id });
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={isOwner ? t("descriptionOwner") : t("descriptionMember")}
      />

      {!isOwner && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" />
          {t("readOnlyNote")}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SunMoon className="size-4 text-muted-foreground" />
          {t("mode")}
        </h3>

        <div
          role="radiogroup"
          aria-label="Color mode"
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              isActive={m === mode}
              disabled={!isOwner || saving}
              onPick={() => pickMode(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette className="size-4 text-muted-foreground" />
          {t("accentColor")}
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((tObj) => (
            <ThemeCard
              key={tObj.id}
              id={tObj.id}
              name={tObj.name}
              tagline={tObj.tagline}
              swatch={tObj.swatch}
              isActive={tObj.id === theme}
              disabled={!isOwner || saving}
              onPick={() => pickTheme(tObj.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ModeCard({
  mode,
  isActive,
  disabled,
  onPick,
}: {
  mode: Mode;
  isActive: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("Settings.appearance");
  const isLight = mode === "light";
  const Icon = isLight ? Sun : Moon;
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      disabled={disabled}
      aria-checked={isActive}
      aria-label={t("useMode", { mode })}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-60",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : !disabled && "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 text-sm font-semibold capitalize text-foreground">
        {mode}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {t("active")}
        </span>
      )}
    </button>
  );
}

function ThemeCard({
  id,
  name,
  tagline,
  swatch,
  isActive,
  disabled,
  onPick,
}: {
  id: ThemeId;
  name: string;
  tagline: string;
  swatch: string;
  isActive: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("Settings.appearance");
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={isActive}
      aria-label={t("useTheme", { name })}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-60",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : !disabled && "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.15)",
          }}
        />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" />
            {t("active")}
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{name}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {tagline}
        </div>
      </div>
      <div
        className="mt-1 flex h-2 overflow-hidden rounded-full"
        aria-hidden
      >
        <span className="flex-1" style={{ background: swatch }} />
        <span className="w-3 bg-muted-foreground/60" />
        <span className="w-3 bg-muted" />
        <span className="w-3 bg-card" />
      </div>
      <span className="sr-only">Theme id: {id}</span>
    </button>
  );
}
