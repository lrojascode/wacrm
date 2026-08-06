/**
 * Bridge between the app's next-intl locale and date-fns' own locale
 * objects.
 *
 * date-fns formats in English unless you hand it a locale, so a page
 * whose copy is fully translated still renders "about 2 hours ago" or
 * "Aug 10, 2026" in the middle of Spanish text. The two libraries have
 * separate locale registries and neither knows about the other; this
 * module is the one place that maps between them.
 *
 * Kept as an explicit map rather than a dynamic `import(\`date-fns/
 * locale/${code}\`)`: the dynamic form defeats bundling (every locale
 * date-fns ships gets pulled in) and would turn a wrong locale string
 * into a runtime import failure instead of the English fallback.
 */

import { es, ko, enUS, type Locale } from 'date-fns/locale';

/** Locale codes with a dictionary under `messages/`. */
const DATE_LOCALES: Record<string, Locale> = {
  es,
  ko,
  en: enUS,
};

/**
 * date-fns locale for an app locale code. Falls back to English for
 * anything unmapped, which matches what `src/i18n/request.ts` does
 * with an unknown `NEXT_PUBLIC_APP_LOCALE`.
 *
 * Accepts regional codes ('es-PE', 'en-GB') by taking the language
 * subtag — next-intl is configured with bare codes today, but a
 * regional one landing here should degrade to the right language
 * rather than silently to English.
 */
export function dateFnsLocale(locale: string): Locale {
  return DATE_LOCALES[locale] ?? DATE_LOCALES[locale.split('-')[0]] ?? enUS;
}

/**
 * Short "month + day", ordered the way the locale writes it — for
 * chart axes and other places with no room for a full date.
 *
 * date-fns has localized tokens for whole dates (`P`, `PP`, `PPP`) but
 * none for month-and-day alone, so a literal `'MMM d'` pattern bakes in
 * English order and renders "ago 10" in Spanish. `Intl` knows the order
 * for every locale, which beats maintaining a per-locale pattern table.
 */
export function formatMonthDay(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}
