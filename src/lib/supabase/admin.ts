import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------
// Service-role Supabase client — one lazy instance for the whole
// server process.
//
// Used by every path that runs without an `auth.uid()`: the inbound
// WhatsApp webhook, the Flows and Automations engines, the AI
// auto-reply bot, the ads sync, the call control routes and the cron
// endpoints. Also used for the few account-level writes migration 047
// deliberately revoked from the `authenticated` role (brand_name,
// logo_url on `accounts`).
//
// IMPORTANT: this client bypasses row-level security. Every query made
// through it has to scope itself by `account_id` explicitly — there is
// no policy behind it to catch a missing filter. The contact lookups
// in src/lib/flows/meta-send.ts spell out what goes wrong without it.
//
// This replaced six byte-identical copies of the same factory, one per
// subsystem. They had already stopped respecting the boundary that
// justified the split — lib/whatsapp, lib/api-keys and lib/auth were
// all importing the Flows copy — so the duplication was costing six
// files and buying nothing.
// ------------------------------------------------------------
let adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return adminClient
}
