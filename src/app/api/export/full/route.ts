// ============================================================
// GET /api/export/full — owner-only JSONL full export for AI
//
// Exports complete CRM data for the account in JSONL (NDJSON) format:
// One JSON object per contact per line, containing contact details,
// tags, custom fields, attribution (including campaign name resolution),
// deals (with pipeline/stage names, status, value, closed_at), and
// full message history (all content_types: text, audio, image, video, etc.).
//
// Paginated internally by contact batches and streamed as a ReadableStream.
// Gated by requireRole('owner') — returns 403 for admin and other roles.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/account/admin-client';

const BATCH_SIZE = 50;

export async function GET() {
  try {
    const ctx = await requireRole('owner');
    const admin = supabaseAdmin();

    // 1. Pre-fetch ad campaigns mapping for attribution resolution
    const { data: campaigns } = await admin
      .from('ad_campaigns')
      .select('id, external_id, name')
      .eq('account_id', ctx.accountId);

    const campaignMap = new Map<string, string>();
    if (campaigns) {
      for (const c of campaigns) {
        if (c.id) campaignMap.set(c.id, c.name);
        if (c.external_id) campaignMap.set(c.external_id, c.name);
      }
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let offset = 0;
          let hasMore = true;

          while (hasMore) {
            // Fetch batch of contacts
            const { data: contacts, error: contactsErr } = await admin
              .from('contacts')
              .select('*')
              .eq('account_id', ctx.accountId)
              .order('created_at', { ascending: false })
              .range(offset, offset + BATCH_SIZE - 1);

            if (contactsErr || !contacts || contacts.length === 0) {
              hasMore = false;
              break;
            }

            const contactIds = contacts.map((c) => c.id);

            // Fetch related data in parallel for the batch
            const [
              { data: contactTags },
              { data: customValues },
              { data: deals },
              { data: conversations },
            ] = await Promise.all([
              admin
                .from('contact_tags')
                .select('contact_id, tags(id, name, color)')
                .in('contact_id', contactIds),
              admin
                .from('contact_custom_values')
                .select('contact_id, value, custom_fields(field_name, field_type)')
                .in('contact_id', contactIds),
              admin
                .from('deals')
                .select(
                  'id, contact_id, title, value, currency, status, closed_at, created_at, updated_at, pipelines(name), pipeline_stages(name)',
                )
                .in('contact_id', contactIds),
              admin
                .from('conversations')
                .select('id, contact_id, status, unread_count, created_at, updated_at')
                .in('contact_id', contactIds),
            ]);

            // Index tags by contact_id
            const tagsByContact = new Map<string, Array<{ id: string; name: string; color: string }>>();
            if (contactTags) {
              for (const ct of contactTags) {
                const tagObj = (ct as unknown as { tags?: { id: string; name: string; color: string } | null }).tags;
                if (tagObj) {
                  const existing = tagsByContact.get(ct.contact_id) || [];
                  existing.push({ id: tagObj.id, name: tagObj.name, color: tagObj.color });
                  tagsByContact.set(ct.contact_id, existing);
                }
              }
            }

            // Index custom values by contact_id
            const customValuesByContact = new Map<
              string,
              Array<{ field_name: string; field_type: string; value: string | null }>
            >();
            if (customValues) {
              for (const cv of customValues) {
                const fieldObj = (cv as unknown as { custom_fields?: { field_name: string; field_type: string } | null }).custom_fields;
                if (fieldObj) {
                  const existing = customValuesByContact.get(cv.contact_id) || [];
                  existing.push({
                    field_name: fieldObj.field_name,
                    field_type: fieldObj.field_type,
                    value: cv.value,
                  });
                  customValuesByContact.set(cv.contact_id, existing);
                }
              }
            }

            // Index deals by contact_id
            const dealsByContact = new Map<string, Array<Record<string, unknown>>>();
            if (deals) {
              for (const d of deals) {
                const pipelineObj = (d as unknown as { pipelines?: { name?: string } | null }).pipelines;
                const stageObj = (d as unknown as { pipeline_stages?: { name?: string } | null }).pipeline_stages;
                const dealRecord = {
                  id: d.id,
                  title: d.title,
                  value: d.value,
                  currency: d.currency,
                  status: d.status,
                  closed_at: d.closed_at,
                  pipeline_name: pipelineObj?.name || null,
                  stage_name: stageObj?.name || null,
                  created_at: d.created_at,
                  updated_at: d.updated_at,
                };
                const existing = dealsByContact.get(d.contact_id) || [];
                existing.push(dealRecord);
                dealsByContact.set(d.contact_id, existing);
              }
            }

            // Index conversation by contact_id and collect conversation_ids for messages fetch
            const convByContact = new Map<string, Record<string, unknown>>();
            const convIds: string[] = [];
            if (conversations) {
              for (const conv of conversations) {
                convByContact.set(conv.contact_id, conv);
                convIds.push(conv.id);
              }
            }

            // Fetch ALL messages for this batch's conversations without filtering content_type
            const messagesByConv = new Map<string, Array<Record<string, unknown>>>();
            if (convIds.length > 0) {
              const { data: messages } = await admin
                .from('messages')
                .select('*')
                .in('conversation_id', convIds)
                .order('created_at', { ascending: true });

              if (messages) {
                for (const m of messages) {
                  const existing = messagesByConv.get(m.conversation_id) || [];
                  existing.push(m);
                  messagesByConv.set(m.conversation_id, existing);
                }
              }
            }

            // Build JSON object per contact and stream
            for (const contact of contacts) {
              const convObj = convByContact.get(contact.id) || null;
              let conversationData = null;

              if (convObj) {
                const msgs = messagesByConv.get(convObj.id as string) || [];
                conversationData = {
                  ...convObj,
                  messages: msgs,
                };
              }

              const originCampaignName = contact.source_campaign_id
                ? campaignMap.get(contact.source_campaign_id) || contact.source_campaign_id
                : null;

              const record = {
                contact: {
                  id: contact.id,
                  phone: contact.phone,
                  name: contact.name,
                  email: contact.email,
                  company: contact.company,
                  avatar_url: contact.avatar_url,
                  source: contact.source,
                  source_ad_id: contact.source_ad_id,
                  source_campaign_id: contact.source_campaign_id,
                  source_meta: contact.source_meta,
                  source_captured_at: contact.source_captured_at,
                  created_at: contact.created_at,
                  updated_at: contact.updated_at,
                },
                tags: tagsByContact.get(contact.id) || [],
                custom_fields: customValuesByContact.get(contact.id) || [],
                attribution: {
                  source: contact.source,
                  source_ad_id: contact.source_ad_id,
                  source_campaign_id: contact.source_campaign_id,
                  origin_campaign_name: originCampaignName,
                },
                deals: dealsByContact.get(contact.id) || [],
                conversation: conversationData,
              };

              controller.enqueue(encoder.encode(JSON.stringify(record) + '\n'));
            }

            if (contacts.length < BATCH_SIZE) {
              hasMore = false;
            } else {
              offset += BATCH_SIZE;
            }
          }
        } catch (streamErr) {
          console.error('[GET /api/export/full] streaming error:', streamErr);
        } finally {
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': 'attachment; filename="full-crm-export.jsonl"',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
