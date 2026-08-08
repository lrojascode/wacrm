/**
 * Which unresolved ad ids the sync should ask Meta about on this run.
 *
 * Resolving an ad costs one Graph API call — Meta has no bulk
 * "ad -> campaign" lookup — so the sync cannot simply retry everything
 * every run. The first version went too far the other way: it skipped
 * any ad that already had an `ad_entities` row, and a row was written on
 * failure as well as on success. That made every failure permanent,
 * including two that are routine:
 *
 *   - a transient Graph error or rate-limit, and
 *   - "ad resolved but its campaign is not synced yet", which happens
 *     whenever the campaigns pass didn't see the campaign that run.
 *
 * A permanently stranded ad is not a cosmetic problem: its contacts keep
 * `source_campaign_id = NULL` forever, so those leads never show up in
 * the campaign's leads or revenue and the ROI reads low with no
 * indication why.
 *
 * So: retry, but with a widening gap and a hard stop. Pure function,
 * separate from sync.ts, so the policy can be tested without a database
 * or a fake Graph API — same reasoning as metrics.ts and roi.ts.
 */

/** Give up after this many failed attempts on one ad. */
export const MAX_ATTEMPTS = 5

/**
 * Group already-resolved ads by their campaign's META id, ready for one
 * UPDATE per campaign.
 *
 * `ad_entities.campaign_id` is our internal `ad_campaigns.id`, but
 * `contacts.source_campaign_id` holds Meta's external id — that is what
 * the /campaigns reports join on (src/lib/ads/queries.ts). Getting this
 * translation backwards would write ids that match nothing and leave the
 * lead count reading zero, so it lives here as a pure function rather
 * than inline in the sync's IO path.
 *
 * Entities whose campaign is missing from `campaigns` are dropped: the
 * campaigns pass hadn't synced it yet, and the next run will pick the ad
 * up again.
 */
export function groupAdsByCampaignExternalId(
  entities: { adId: string; campaignId: string | null }[],
  campaigns: { id: string; externalId: string }[],
): Map<string, string[]> {
  const externalById = new Map(campaigns.map((c) => [c.id, c.externalId]))
  const out = new Map<string, string[]>()

  for (const entity of entities) {
    if (!entity.campaignId) continue
    const externalId = externalById.get(entity.campaignId)
    if (!externalId) continue
    const list = out.get(externalId) ?? []
    list.push(entity.adId)
    out.set(externalId, list)
  }

  return out
}

/**
 * Minimum wait before attempt N+1, indexed by attempts already made.
 * Starts immediate (a brand-new ad is tried on the next run) and widens
 * to a day, so a genuinely broken ad costs at most a handful of calls
 * over its lifetime while a blip recovers within the hour.
 */
const BACKOFF_MS = [
  0,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]

/** An `ad_entities` row as far as this policy is concerned. */
export interface AdResolutionCandidate {
  adId: string
  /** Our internal ad_campaigns.id. Non-null means done — never retry. */
  campaignId: string | null
  attempts: number
  /** When we last called Meta about it. Null means never tried. */
  lastAttemptAt: Date | null
}

export interface SelectAdsArgs {
  candidates: AdResolutionCandidate[]
  now: Date
  /** Hard cap on Graph calls this run. */
  max: number
}

/** Whether one candidate is due for another attempt right now. */
export function isDueForRetry(candidate: AdResolutionCandidate, now: Date): boolean {
  if (candidate.campaignId !== null) return false
  if (candidate.attempts >= MAX_ATTEMPTS) return false
  // Never attempted (or attempted before this column existed): due now.
  if (!candidate.lastAttemptAt) return true

  const wait = BACKOFF_MS[Math.min(candidate.attempts, BACKOFF_MS.length - 1)]
  return now.getTime() - candidate.lastAttemptAt.getTime() >= wait
}

/**
 * Pick the ad ids to resolve this run, fewest attempts first.
 *
 * Ordering matters under the cap: without it a backlog of near-exhausted
 * ads could keep crowding out ads nobody has tried yet, so a fresh
 * campaign's leads would sit unattributed behind a queue of failures.
 */
export function selectAdsToResolve({ candidates, now, max }: SelectAdsArgs): string[] {
  if (max <= 0) return []

  return candidates
    .filter((c) => isDueForRetry(c, now))
    .sort((a, b) => {
      if (a.attempts !== b.attempts) return a.attempts - b.attempts
      // Stable, deterministic tiebreak so tests don't depend on input
      // order and two runs pick the same ads.
      return a.adId.localeCompare(b.adId)
    })
    .slice(0, max)
    .map((c) => c.adId)
}
