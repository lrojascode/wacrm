'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Megaphone, RefreshCw, Loader2, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { daysAgoStart } from '@/lib/dashboard/date-utils'
import { loadCampaigns, type CampaignRow } from '@/lib/ads/queries'
import { countPausedCampaigns, visibleCampaigns } from '@/lib/ads/campaign-visibility'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ManualCampaignDialog } from '@/components/campaigns/manual-campaign-dialog'
import { EditSpendDialog } from '@/components/campaigns/edit-spend-dialog'
import { TrackedLinksCard } from '@/components/campaigns/tracked-links-card'

type RangeDays = 7 | 30 | 90

export default function CampaignsPage() {
  const t = useTranslations('Campaigns.page')
  const { canEditSettings, defaultCurrency } = useAuth()
  const supabase = createClient()

  const [range, setRange] = useState<RangeDays>(30)
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([])
  const [hasAdAccounts, setHasAdAccounts] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [showPaused, setShowPaused] = useState(false)

  const fetchCampaigns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadCampaigns(
        supabase,
        { since: daysAgoStart(range - 1), until: new Date() },
        defaultCurrency,
      )
      setCampaigns(result.campaigns)
      setHasAdAccounts(result.hasAdAccounts)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns')
    }
    setLoading(false)
  }, [supabase, range, defaultCurrency])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCampaigns()
  }, [fetchCampaigns])

  // See campaign-visibility.ts for why paused rows are filtered here
  // rather than in the query, and why the check is an equality against
  // 'PAUSED'.
  const pausedCount = countPausedCampaigns(campaigns)
  const visibleRows = visibleCampaigns(campaigns, showPaused)

  async function handleSyncNow() {
    setSyncing(true)
    const res = await fetch('/api/ads/sync', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setSyncing(false)
    if (!res.ok) {
      toast.error(data.error || t('syncFailed'))
      return
    }
    // A 200 only means the sync ran, not that every connected account
    // synced cleanly — each ad account reports its own error (e.g. a
    // missing/expired token) inside `results`. Same check as the
    // Settings "Sync now" button (ads-settings.tsx).
    const failed = (data.results ?? []).filter((r: { error: string | null }) => r.error)
    if (failed.length > 0) {
      toast.error(t('syncFailed'))
    } else {
      toast.success(t('syncSuccess'))
    }
    fetchCampaigns()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {([7, 30, 90] as RangeDays[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  range === r
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('days', { count: r })}
              </button>
            ))}
          </div>
          {pausedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPaused((v) => !v)}
              aria-pressed={showPaused}
              className="border-border text-foreground"
            >
              {showPaused ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
              {showPaused ? t('hidePaused') : t('showPaused', { count: pausedCount })}
            </Button>
          )}
          {canEditSettings && hasAdAccounts && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncNow}
              disabled={syncing}
              className="border-border text-foreground"
            >
              {syncing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t('syncNow')}
            </Button>
          )}
          {canEditSettings && (
            <ManualCampaignDialog defaultCurrency={defaultCurrency} onCreated={fetchCampaigns} />
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <EmptyState icon={Megaphone} title={t('loadError')} hint={error} />
        ) : !hasAdAccounts ? (
          <EmptyState
            icon={Megaphone}
            title={t('noAdAccountTitle')}
            hint={canEditSettings ? t('noAdAccountHintAdmin') : t('noAdAccountHint')}
          />
        ) : visibleRows.length === 0 ? (
          // Distinguish "this account has no campaigns" from "every
          // campaign in range is paused and therefore hidden" — the
          // second one otherwise reads as data loss.
          <EmptyState
            icon={Megaphone}
            title={t('noCampaignsTitle')}
            hint={pausedCount > 0 ? t('allPausedHint') : t('noCampaignsHint')}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.campaign')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.spend')}</TableHead>
                  <TableHead className="text-right">{t('columns.leads')}</TableHead>
                  <TableHead className="text-right">{t('columns.costPerLead')}</TableHead>
                  <TableHead className="text-right">{t('columns.roi')}</TableHead>
                  <TableHead className="text-right">{t('columns.messagingStarted')}</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`platform.${c.platform}`)}
                        {c.isManual && ` · ${t('manualEntry')}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      {c.effectiveStatus ? (
                        <Badge
                          variant={c.effectiveStatus === 'ACTIVE' ? 'default' : 'secondary'}
                          className="text-[10px]"
                        >
                          {c.effectiveStatus}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(c.spend, c.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.costPerLead === null
                        ? t('notAvailable')
                        : formatCurrency(c.costPerLead, c.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {!c.roiComparable ? (
                        <span className="text-xs text-amber-500" title={t('roiCurrencyMismatch')}>
                          {t('notComparable')}
                        </span>
                      ) : c.roi === null ? (
                        t('notAvailable')
                      ) : (
                        <span className={c.roi >= 0 ? 'text-emerald-500' : 'text-destructive'}>
                          {(c.roi * 100).toFixed(0)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.messagingStarted === null ? t('notAvailable') : c.messagingStarted}
                    </TableCell>
                    <TableCell>
                      {c.isManual && canEditSettings && (
                        <EditSpendDialog
                          campaignId={c.id}
                          campaignName={c.name}
                          currency={c.currency}
                          onSaved={fetchCampaigns}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {hasAdAccounts && (
        <p className="text-xs text-muted-foreground">
          {t('doubleCountNotice')}{' '}
          {canEditSettings && (
            <Link href="/settings?tab=ads" className="text-primary hover:underline">
              {t('manageAdAccounts')}
            </Link>
          )}
        </p>
      )}

      <TrackedLinksCard campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  )
}
