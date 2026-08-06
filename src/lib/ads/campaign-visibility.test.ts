import { describe, expect, it } from 'vitest';
import {
  countPausedCampaigns,
  isPausedCampaign,
  visibleCampaigns,
} from './campaign-visibility';

const active = { effectiveStatus: 'ACTIVE', name: 'Promo julio' };
const paused = { effectiveStatus: 'PAUSED', name: 'Promo junio' };
// What queries.ts produces for a manually-tracked campaign: Meta never
// reported a status because Meta never saw this campaign.
const manual = { effectiveStatus: null, name: 'Google - marca' };

describe('isPausedCampaign', () => {
  it('is true only for the literal PAUSED status', () => {
    expect(isPausedCampaign(paused)).toBe(true);
    expect(isPausedCampaign(active)).toBe(false);
  });

  it('is false for a manual campaign with no status', () => {
    // The regression this whole module exists to prevent: a
    // `!== 'ACTIVE'` filter would treat null as paused and hide every
    // hand-tracked Google campaign along with the paused Meta ones.
    expect(isPausedCampaign(manual)).toBe(false);
  });

  it('is false for statuses Meta may add later', () => {
    expect(isPausedCampaign({ effectiveStatus: 'ARCHIVED' })).toBe(false);
    expect(isPausedCampaign({ effectiveStatus: 'IN_PROCESS' })).toBe(false);
  });
});

describe('visibleCampaigns', () => {
  it('drops paused rows but keeps active and manual ones', () => {
    const out = visibleCampaigns([active, paused, manual], false);
    expect(out).toEqual([active, manual]);
  });

  it('returns everything when the toggle is on', () => {
    const out = visibleCampaigns([active, paused, manual], true);
    expect(out).toEqual([active, paused, manual]);
  });

  it('does not mutate the input', () => {
    const rows = [active, paused];
    visibleCampaigns(rows, false);
    expect(rows).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(visibleCampaigns([], false)).toEqual([]);
  });
});

describe('countPausedCampaigns', () => {
  it('counts only the paused rows', () => {
    expect(countPausedCampaigns([active, paused, manual, paused])).toBe(2);
  });

  it('is 0 when nothing is paused, so the toggle stays hidden', () => {
    expect(countPausedCampaigns([active, manual])).toBe(0);
  });
});
