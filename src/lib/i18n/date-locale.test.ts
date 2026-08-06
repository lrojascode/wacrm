import { describe, expect, it } from 'vitest';
import { formatDistanceToNow } from 'date-fns';
import { dateFnsLocale, formatMonthDay } from './date-locale';

describe('dateFnsLocale', () => {
  it('formats relative dates in Spanish for "es"', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const out = formatDistanceToNow(twoHoursAgo, {
      addSuffix: true,
      locale: dateFnsLocale('es'),
    });
    // The exact wording is date-fns', not ours — assert it stopped
    // being English rather than pinning their copy.
    expect(out).toContain('hace');
    expect(out).not.toContain('ago');
  });

  it('falls back to English for an unmapped locale', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const out = formatDistanceToNow(twoHoursAgo, {
      addSuffix: true,
      locale: dateFnsLocale('fr'),
    });
    expect(out).toContain('ago');
  });

  it('resolves a regional code to its language', () => {
    // next-intl uses bare codes today, but NEXT_PUBLIC_APP_LOCALE is a
    // free-text env var — 'es-PE' must not silently mean English.
    expect(dateFnsLocale('es-PE')).toBe(dateFnsLocale('es'));
  });

  it('does not throw on an empty locale', () => {
    expect(() => dateFnsLocale('')).not.toThrow();
  });
});

describe('formatMonthDay', () => {
  const aug10 = new Date(2026, 7, 10);

  it('puts the day before the month in Spanish', () => {
    // The bug this replaces: date-fns "MMM d" renders "ago 10".
    const out = formatMonthDay(aug10, 'es');
    expect(out).toMatch(/^10/);
    expect(out).toMatch(/ago/);
  });

  it('puts the month before the day in English', () => {
    const out = formatMonthDay(aug10, 'en');
    expect(out).toMatch(/^Aug/);
    expect(out).toMatch(/10$/);
  });
});
