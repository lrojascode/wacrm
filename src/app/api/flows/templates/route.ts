import { NextResponse } from 'next/server';
import { listFlowTemplates } from '@/lib/flows/templates';
import { withRoute } from '@/lib/auth/guard';

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Available to any signed-in user. Flows is in soft-GA.
 */
// Flows are admin-only in the UI (useRequireRole in flows/page.tsx).
// That guard was purely cosmetic until now: the route itself checked
// nothing, so a `curl` with any member's cookie read the catalogue.
export const GET = withRoute({ minRole: 'admin' }, async () => {
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }));
  return NextResponse.json({ templates });
});
