import { describe, expect, it } from 'vitest'

import {
  MAX_ATTEMPTS,
  groupAdsByCampaignExternalId,
  isDueForRetry,
  selectAdsToResolve,
  type AdResolutionCandidate,
} from './resolution-policy'

const NOW = new Date('2026-07-26T12:00:00Z')

function candidate(over: Partial<AdResolutionCandidate> = {}): AdResolutionCandidate {
  return {
    adId: 'ad-1',
    campaignId: null,
    attempts: 0,
    lastAttemptAt: null,
    ...over,
  }
}

/** `minutes` before NOW. */
function ago(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000)
}

describe('groupAdsByCampaignExternalId', () => {
  it('translates the internal campaign id to Meta’s external id', () => {
    // The whole point: contacts.source_campaign_id stores the EXTERNAL
    // id, which is what the /campaigns reports join on. Writing the
    // internal uuid here would match nothing and the lead count would
    // read zero with no error anywhere.
    const out = groupAdsByCampaignExternalId(
      [{ adId: 'ad-1', campaignId: 'internal-uuid-1' }],
      [{ id: 'internal-uuid-1', externalId: '23851234567890123' }],
    )

    expect(out.get('23851234567890123')).toEqual(['ad-1'])
  })

  it('groups every ad of one campaign into a single entry', () => {
    const out = groupAdsByCampaignExternalId(
      [
        { adId: 'ad-1', campaignId: 'c1' },
        { adId: 'ad-2', campaignId: 'c1' },
        { adId: 'ad-3', campaignId: 'c2' },
      ],
      [
        { id: 'c1', externalId: 'ext-1' },
        { id: 'c2', externalId: 'ext-2' },
      ],
    )

    expect(out.get('ext-1')).toEqual(['ad-1', 'ad-2'])
    expect(out.get('ext-2')).toEqual(['ad-3'])
    expect(out.size).toBe(2)
  })

  it('drops ads whose campaign has not been synced yet', () => {
    // The campaigns pass didn't see it this run. Skipping leaves the
    // contact pending, so the next run picks it up — better than
    // stamping an id the reports cannot resolve.
    const out = groupAdsByCampaignExternalId(
      [{ adId: 'ad-1', campaignId: 'not-synced' }],
      [{ id: 'other', externalId: 'ext-1' }],
    )

    expect(out.size).toBe(0)
  })

  it('ignores unresolved ads', () => {
    const out = groupAdsByCampaignExternalId(
      [{ adId: 'ad-1', campaignId: null }],
      [{ id: 'c1', externalId: 'ext-1' }],
    )

    expect(out.size).toBe(0)
  })
})

describe('isDueForRetry', () => {
  it('tries an ad nobody has attempted yet', () => {
    expect(isDueForRetry(candidate(), NOW)).toBe(true)
  })

  it('never retries an ad that already resolved', () => {
    expect(isDueForRetry(candidate({ campaignId: 'campaign-1', attempts: 1 }), NOW)).toBe(false)
  })

  it('gives up after MAX_ATTEMPTS', () => {
    const exhausted = candidate({ attempts: MAX_ATTEMPTS, lastAttemptAt: ago(60 * 24 * 30) })
    expect(isDueForRetry(exhausted, NOW)).toBe(false)
  })

  it('waits out the backoff, then retries', () => {
    // One failure: 15 minutes before the next try.
    expect(isDueForRetry(candidate({ attempts: 1, lastAttemptAt: ago(14) }), NOW)).toBe(false)
    expect(isDueForRetry(candidate({ attempts: 1, lastAttemptAt: ago(16) }), NOW)).toBe(true)
  })

  it('widens the gap as attempts pile up', () => {
    // Two failures: an hour. Half an hour is not enough any more, even
    // though it would have been after the first failure.
    expect(isDueForRetry(candidate({ attempts: 2, lastAttemptAt: ago(30) }), NOW)).toBe(false)
    expect(isDueForRetry(candidate({ attempts: 2, lastAttemptAt: ago(61) }), NOW)).toBe(true)
    // Four failures: a day.
    expect(isDueForRetry(candidate({ attempts: 4, lastAttemptAt: ago(60 * 23) }), NOW)).toBe(false)
    expect(isDueForRetry(candidate({ attempts: 4, lastAttemptAt: ago(60 * 25) }), NOW)).toBe(true)
  })

  it('retries a row that predates attempt tracking', () => {
    // Rows stranded by the old always-skip behaviour have attempts = 0
    // (the column default) and no last_attempt_at. They are exactly the
    // ones worth picking up once this ships.
    expect(isDueForRetry(candidate({ attempts: 0, lastAttemptAt: null }), NOW)).toBe(true)
  })
})

describe('selectAdsToResolve', () => {
  it('returns only the ads that are due', () => {
    const picked = selectAdsToResolve({
      candidates: [
        candidate({ adId: 'fresh' }),
        candidate({ adId: 'done', campaignId: 'c1' }),
        candidate({ adId: 'exhausted', attempts: MAX_ATTEMPTS, lastAttemptAt: ago(60 * 48) }),
        candidate({ adId: 'cooling', attempts: 1, lastAttemptAt: ago(2) }),
        candidate({ adId: 'ready', attempts: 1, lastAttemptAt: ago(30) }),
      ],
      now: NOW,
      max: 10,
    })
    expect(picked).toEqual(['fresh', 'ready'])
  })

  it('respects the per-run cap', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate({ adId: `ad-${i}` }),
    )
    expect(selectAdsToResolve({ candidates, now: NOW, max: 3 })).toHaveLength(3)
    expect(selectAdsToResolve({ candidates, now: NOW, max: 0 })).toEqual([])
  })

  it('puts never-tried ads ahead of ones that keep failing', () => {
    // The cap is 1, so ordering decides. A new campaign's leads must not
    // queue behind a backlog of near-exhausted failures.
    const picked = selectAdsToResolve({
      candidates: [
        candidate({ adId: 'failing', attempts: 3, lastAttemptAt: ago(60 * 12) }),
        candidate({ adId: 'brand-new', attempts: 0 }),
      ],
      now: NOW,
      max: 1,
    })
    expect(picked).toEqual(['brand-new'])
  })

  it('is deterministic when attempts tie, regardless of input order', () => {
    const a = candidate({ adId: 'aaa' })
    const b = candidate({ adId: 'bbb' })
    expect(selectAdsToResolve({ candidates: [b, a], now: NOW, max: 2 })).toEqual(['aaa', 'bbb'])
    expect(selectAdsToResolve({ candidates: [a, b], now: NOW, max: 2 })).toEqual(['aaa', 'bbb'])
  })

  it('returns nothing when there is nothing to do', () => {
    expect(selectAdsToResolve({ candidates: [], now: NOW, max: 5 })).toEqual([])
    expect(
      selectAdsToResolve({
        candidates: [candidate({ campaignId: 'c1' })],
        now: NOW,
        max: 5,
      }),
    ).toEqual([])
  })
})
