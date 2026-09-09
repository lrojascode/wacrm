// ============================================================
// E2E seed — idempotent by construction.
//
// Runs as Playwright's globalSetup against a LOCAL Supabase stack. It
// must be safe to run repeatedly: CI runs it once per job, but a
// developer will run it dozens of times a day without resetting the
// database, and a seed that only works on a virgin schema is a seed
// nobody runs.
//
// Idempotency strategy, per object type:
//   - auth users   — looked up by email first; created only if absent.
//   - accounts     — resolved from the owner's trigger-created row and
//                    renamed in place.
//   - profiles     — updated in place (the signup trigger already
//                    created the row).
//   - contacts /
//     conversations /
//     messages     — deterministic ids, upserted by id.
//
// Why the service-role client: creating auth users needs the admin
// API (it hashes the password properly — hand-rolling bcrypt in SQL is
// how fixtures rot), and reassigning `profiles.account_role` has to
// bypass the migration-034 trigger. That trigger rejects the change
// only when `current_user` is `authenticated`; PostgREST runs
// service-role requests as `service_role`, so the sanctioned path
// still works. See supabase/migrations/034_fix_profiles_update_rls.sql.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  ACCOUNTS,
  CONVERSATIONS,
  E2E_PASSWORD,
  USERS,
  type SeedAccount,
  type SeedUser,
} from "./fixtures";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The E2E suite needs a local Supabase stack — ` +
        `run \`supabase start\` and export the keys it prints, or source .env.local.`,
    );
  }
  return value;
}

/**
 * Guard rail. This seed creates users and overwrites rows by fixed id;
 * pointing it at a shared or hosted project would be destructive. A
 * local stack is always loopback, so refuse anything else unless the
 * operator opts out explicitly.
 */
function assertLocalTarget(url: string): void {
  const host = new URL(url).hostname;
  const isLocal =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "host.docker.internal";
  if (!isLocal && process.env.E2E_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to seed a non-local Supabase (${host}). The E2E seed creates users ` +
        `and overwrites rows by fixed id. Set E2E_ALLOW_REMOTE=1 only if you are ` +
        `certain the target is disposable.`,
    );
  }
}

export function createAdminClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  assertLocalTarget(url);
  return createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Resolve every fixture email to a user id, creating the ones that do
 * not exist yet. `listUsers` is paginated; a local stack seeded by
 * other work can hold more than one page, so walk it rather than
 * trusting the first response.
 */
async function ensureAuthUsers(admin: SupabaseClient): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>();

  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const user of data.users) {
      if (user.email) byEmail.set(user.email.toLowerCase(), user.id);
    }
    if (data.users.length < 200) break;
  }

  for (const fixture of USERS) {
    const existing = byEmail.get(fixture.email.toLowerCase());
    if (existing) continue;

    const { data, error } = await admin.auth.admin.createUser({
      email: fixture.email,
      password: E2E_PASSWORD,
      // Skip the confirmation mail entirely. The specs sign in through
      // the real login form; an unconfirmed user would be rejected
      // there and the failure would look like a UI bug.
      email_confirm: true,
      user_metadata: { full_name: fixture.fullName },
    });
    if (error || !data.user) {
      throw new Error(`createUser(${fixture.email}) failed: ${error?.message ?? "no user returned"}`);
    }
    byEmail.set(fixture.email.toLowerCase(), data.user.id);
  }

  return byEmail;
}

/**
 * Resolve each fixture account to the row the signup trigger created
 * for its owner, and give it a recognisable name.
 *
 * The id is whatever the trigger generated. Forcing a fixed one is not
 * possible: `profiles.account_id` references `accounts.id` without
 * ON UPDATE CASCADE, so re-keying the row is rejected by the foreign
 * key. Callers get the resolved ids back instead.
 */
async function ensureAccounts(
  admin: SupabaseClient,
  userIds: Map<string, string>,
): Promise<Map<SeedAccount["key"], string>> {
  const accountIds = new Map<SeedAccount["key"], string>();

  for (const account of Object.values(ACCOUNTS)) {
    const owner = USERS.find((u) => u.account === account.key && u.role === "owner");
    if (!owner) throw new Error(`Account "${account.key}" has no owner in the fixtures`);
    const ownerId = userIds.get(owner.email.toLowerCase())!;

    const { data, error } = await admin
      .from("accounts")
      .select("id")
      .eq("owner_user_id", ownerId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`locate account for ${owner.email} failed: ${error.message}`);
    if (!data) {
      throw new Error(
        `No account row for ${owner.email}. The signup trigger (handle_new_user) ` +
          `should have created one — check that migration 017 is applied.`,
      );
    }

    const { error: nameErr } = await admin
      .from("accounts")
      .update({ name: account.name })
      .eq("id", data.id);
    if (nameErr) throw new Error(`rename account ${account.key} failed: ${nameErr.message}`);

    accountIds.set(account.key, data.id as string);
  }

  return accountIds;
}

/**
 * Put every fixture user in the right account with the right role.
 *
 * Non-owner users were made owners of their own account by the signup
 * trigger. Moving their profile leaves that account behind with no
 * members; it is deleted so the fixture does not accumulate orphans
 * across runs. Deleting is safe precisely because nothing was ever
 * written into it.
 */
async function ensureProfiles(
  admin: SupabaseClient,
  userIds: Map<string, string>,
  accountIds: Map<SeedAccount["key"], string>,
): Promise<void> {
  for (const fixture of USERS) {
    const userId = userIds.get(fixture.email.toLowerCase())!;
    const accountId = accountIds.get(fixture.account)!;

    const { data: profile, error: readErr } = await admin
      .from("profiles")
      .select("id, account_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (readErr) throw new Error(`read profile ${fixture.email} failed: ${readErr.message}`);
    if (!profile) throw new Error(`No profile row for ${fixture.email}`);

    const strandedAccountId =
      profile.account_id && profile.account_id !== accountId ? (profile.account_id as string) : null;

    const { error } = await admin
      .from("profiles")
      .update({
        full_name: fixture.fullName,
        account_id: accountId,
        account_role: fixture.role,
      })
      .eq("user_id", userId);
    if (error) {
      throw new Error(
        `set role ${fixture.role} for ${fixture.email} failed: ${error.message}. ` +
          `If this says "account_role cannot be changed directly", the seed is not ` +
          `running as service_role (see migration 034).`,
      );
    }

    if (strandedAccountId) {
      // Only ever removes an account this seed just emptied: it is the
      // trigger-created one for a non-owner fixture, never a fixture
      // account (those are filtered out by the id comparison above).
      await admin.from("accounts").delete().eq("id", strandedAccountId).eq("owner_user_id", userId);
    }
  }
}

/**
 * Contacts, conversations and one inbound message each.
 *
 * `user_id` on these tables predates the multi-tenant migration and is
 * still NOT NULL, so it is set to the account owner. Tenancy is
 * carried by `account_id` (migration 017), which is what the inbox
 * actually filters on.
 */
async function ensureConversations(
  admin: SupabaseClient,
  userIds: Map<string, string>,
  accountIds: Map<SeedAccount["key"], string>,
): Promise<void> {
  const ownerOf = (account: SeedUser["account"]): string => {
    const owner = USERS.find((u) => u.account === account && u.role === "owner")!;
    return userIds.get(owner.email.toLowerCase())!;
  };

  for (const convo of CONVERSATIONS) {
    const ownerId = ownerOf(convo.account);
    const accountId = accountIds.get(convo.account)!;

    const { error: contactErr } = await admin.from("contacts").upsert(
      {
        id: convo.contactId,
        account_id: accountId,
        user_id: ownerId,
        phone: convo.contactPhone,
        name: convo.contactName,
      },
      { onConflict: "id" },
    );
    if (contactErr) throw new Error(`upsert contact ${convo.contactName} failed: ${contactErr.message}`);

    const { error: convoErr } = await admin.from("conversations").upsert(
      {
        id: convo.id,
        account_id: accountId,
        user_id: ownerId,
        contact_id: convo.contactId,
        status: "open",
        last_message_text: convo.firstMessage,
        last_message_at: new Date().toISOString(),
        unread_count: 0,
      },
      { onConflict: "id" },
    );
    if (convoErr) throw new Error(`upsert conversation ${convo.id} failed: ${convoErr.message}`);

    // Deterministic message id derived from the conversation id, so a
    // re-run updates the same row instead of stacking duplicates.
    const messageId = convo.id.replace(/^c/, "d");
    const { error: msgErr } = await admin.from("messages").upsert(
      {
        id: messageId,
        conversation_id: convo.id,
        sender_type: "customer",
        content_type: "text",
        content_text: convo.firstMessage,
        status: "delivered",
      },
      { onConflict: "id" },
    );
    if (msgErr) throw new Error(`upsert message for ${convo.id} failed: ${msgErr.message}`);
  }
}

export async function seed(): Promise<void> {
  const admin = createAdminClient();
  const userIds = await ensureAuthUsers(admin);
  const accountIds = await ensureAccounts(admin, userIds);
  await ensureProfiles(admin, userIds, accountIds);
  await ensureConversations(admin, userIds, accountIds);
}
