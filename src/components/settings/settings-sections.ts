import {
  Coins,
  Download,
  FileText,
  KeyRound,
  LayoutGrid,
  Megaphone,
  Palette,
  PlugZap,
  Shield,
  Sparkles,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'brand',
  'whatsapp',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'ads',
  'members',
  'api',
  'export',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/**
 * Rail grouping. `ownerOnly` sections are hidden from the rail (and
 * blocked in the page render, not just the menu — see
 * `settings/page.tsx`) for anyone below `owner`. These mirror
 * `canEditOwnerSettings` in `@/lib/auth/roles` — five backed by
 * migration 047's owner-only RLS/grants.
 *
 * Appearance is NOT in that set even though only the owner can edit
 * it (migration 051 makes it account-wide) — every member still needs
 * to reach the page to see the read-only view of the account's
 * current pick (appearance-panel.tsx handles the edit-vs-view split
 * itself via `isOwner`). Setting `ownerOnly` here would 404 that view
 * entirely for admin/agent/viewer.
 */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  ownerOnly?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  brand: { id: 'brand', label: 'Brand', icon: Sparkles, group: 'workspace', ownerOnly: true },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace', ownerOnly: true },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace' },
  ads: { id: 'ads', label: 'Ad accounts', icon: Megaphone, group: 'workspace', ownerOnly: true },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace', ownerOnly: true },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', ownerOnly: true },
  export: { id: 'export', label: 'Export data', icon: Download, group: 'workspace', ownerOnly: true },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
