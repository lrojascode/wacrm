/**
 * Which campaign rows the /campaigns table shows.
 *
 * Paused campaigns are hidden by default — the table answers "what is
 * running right now". The filter lives here, not in the query, because
 * a campaign paused halfway through the selected range still spent
 * real money inside it: the rows have to stay one toggle away rather
 * than vanish from the account.
 *
 * Pure and dependency-free so the null-status case below is covered by
 * a unit test instead of by clicking through the page.
 */

/** The only field visibility depends on. Keeps callers (and tests)
 *  from having to build a whole CampaignRow. */
export interface CampaignVisibility {
  effectiveStatus: string | null
}

/**
 * True for a campaign the operator paused in Meta.
 *
 * Deliberately an equality check against 'PAUSED' rather than
 * `!== 'ACTIVE'`. Manual campaigns (Google and friends) carry no
 * `effective_status` at all — see the row builder in queries.ts — so
 * the negated form would quietly hide every manually-tracked campaign
 * alongside the paused Meta ones, and the spend the operator typed in
 * by hand would be the first thing to disappear.
 */
export function isPausedCampaign(campaign: CampaignVisibility): boolean {
  return campaign.effectiveStatus === 'PAUSED'
}

/** Rows to render, given the page's show-paused toggle. */
export function visibleCampaigns<T extends CampaignVisibility>(
  campaigns: T[],
  showPaused: boolean,
): T[] {
  return showPaused ? campaigns : campaigns.filter((c) => !isPausedCampaign(c))
}

/** How many rows the toggle would reveal. Drives whether it renders at
 *  all — a toggle that changes nothing is worse than no toggle. */
export function countPausedCampaigns(campaigns: CampaignVisibility[]): number {
  return campaigns.filter(isPausedCampaign).length
}
