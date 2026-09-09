// ============================================================
// GET /api/contacts/export — owner-only CSV export of contacts
//
// Exports contacts for the account in CSV format.
// Columns are symmetric with contact import (phone, name, email,
// company, tags) plus read-only extras: source, origin_campaign, created_at.
// Gated by requireRole('owner') — returns 403 for admin and other roles.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { toCsv } from '@/lib/export/csv';
import { fetchAllPages } from '@/lib/export/paginate';

export async function GET() {
  try {
    const ctx = await requireRole('owner');
    const admin = supabaseAdmin();

    const [contacts, campaigns] = await Promise.all([
      fetchAllPages((from, to) =>
        admin
          .from('contacts')
          .select('*, contact_tags(tags(name))')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      fetchAllPages((from, to) =>
        admin
          .from('ad_campaigns')
          .select('id, external_id, name')
          .eq('account_id', ctx.accountId)
          .range(from, to),
      ),
    ]);

    const campaignMap = new Map<string, string>();
    if (campaigns) {
      for (const c of campaigns) {
        if (c.id) campaignMap.set(c.id, c.name);
        if (c.external_id) campaignMap.set(c.external_id, c.name);
      }
    }

    const header = [
      'phone',
      'name',
      'email',
      'company',
      'tags',
      'source',
      'origin_campaign',
      'created_at',
    ];
    const rows: string[][] = [header];

    for (const c of contacts || []) {
      const tagNames = (c.contact_tags || [])
        .map((ct: { tags?: { name?: string } | null }) => ct.tags?.name)
        .filter((n?: string): n is string => typeof n === 'string' && n.length > 0)
        .join(', ');

      const originCampaign = c.source_campaign_id
        ? campaignMap.get(c.source_campaign_id) || c.source_campaign_id
        : '';

      rows.push([
        c.phone || '',
        c.name || '',
        c.email || '',
        c.company || '',
        tagNames,
        c.source || '',
        originCampaign,
        c.created_at || '',
      ]);
    }

    const csvContent = toCsv(rows);

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="contacts-export.csv"',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
