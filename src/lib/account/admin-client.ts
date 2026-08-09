import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for account-level writes that a
// migration deliberately revoked from the authenticated role (e.g.
// accounts.brand_name / logo_url — see migration 047). Mirrors the
// same small helper duplicated per subsystem — see
// src/lib/whatsapp/admin-client.ts.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
