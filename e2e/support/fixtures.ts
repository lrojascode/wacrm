// ============================================================
// Fixture catalogue — the single source of truth for what the E2E
// seed creates and what the specs assert against.
//
// Conversation and contact ids are deterministic on purpose. The
// cross-tenant tests navigate to a conversation belonging to *another*
// account without first reading it — reading it would require access,
// which is exactly what those tests prove is denied — so the id has to
// be known up front rather than discovered at runtime.
//
// Two accounts, because a single-tenant fixture cannot catch the class
// of bug that matters most here: one account's data leaking into
// another's session.
// ============================================================

/** Shared by every seeded user. Local fixtures only — never a real secret. */
export const E2E_PASSWORD = "e2e-Test-Password-1";

export interface SeedAccount {
  /** Stable key used by the specs. */
  key: "acme" | "globex";
  name: string;
}

/**
 * Accounts are identified by key, not by a fixed uuid.
 *
 * A deterministic account id would have to be forced onto the row the
 * signup trigger already created, and `profiles.account_id` references
 * it without ON UPDATE CASCADE — re-keying is rejected by the foreign
 * key. Nothing needs it anyway: the specs address conversations, whose
 * ids this seed does control.
 */
export const ACCOUNTS: Record<SeedAccount["key"], SeedAccount> = {
  acme: { key: "acme", name: "Acme E2E" },
  globex: { key: "globex", name: "Globex E2E" },
};

export type SeedRole = "owner" | "admin" | "agent" | "viewer";

export interface SeedUser {
  key: string;
  email: string;
  fullName: string;
  role: SeedRole;
  account: SeedAccount["key"];
}

/**
 * Acme carries all four roles so the authorisation matrix can be
 * driven from one account. Globex only needs an owner — it exists to
 * be the "other tenant", not to be exercised in depth.
 */
export const USERS: SeedUser[] = [
  {
    key: "acmeOwner",
    email: "e2e-acme-owner@local.test",
    fullName: "Acme Owner",
    role: "owner",
    account: "acme",
  },
  {
    key: "acmeAdmin",
    email: "e2e-acme-admin@local.test",
    fullName: "Acme Admin",
    role: "admin",
    account: "acme",
  },
  {
    key: "acmeAgent",
    email: "e2e-acme-agent@local.test",
    fullName: "Acme Agent",
    role: "agent",
    account: "acme",
  },
  {
    key: "acmeViewer",
    email: "e2e-acme-viewer@local.test",
    fullName: "Acme Viewer",
    role: "viewer",
    account: "acme",
  },
  {
    key: "globexOwner",
    email: "e2e-globex-owner@local.test",
    fullName: "Globex Owner",
    role: "owner",
    account: "globex",
  },
];

export function userByKey(key: string): SeedUser {
  const found = USERS.find((u) => u.key === key);
  if (!found) throw new Error(`No seeded user with key "${key}"`);
  return found;
}

export interface SeedConversation {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  account: SeedAccount["key"];
  /** First message body — what the thread should show once opened. */
  firstMessage: string;
}

/**
 * Three conversations in Acme (enough to exercise back/forward across
 * distinct selections) and one in Globex (the cross-tenant target).
 */
export const CONVERSATIONS: SeedConversation[] = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    contactId: "b0000000-0000-4000-8000-000000000001",
    contactName: "Ana Torres",
    contactPhone: "+51900000001",
    account: "acme",
    firstMessage: "Hola, quiero informacion sobre el plan anual",
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    contactId: "b0000000-0000-4000-8000-000000000002",
    contactName: "Bruno Diaz",
    contactPhone: "+51900000002",
    account: "acme",
    firstMessage: "Buenas, sigo esperando la cotizacion",
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    contactId: "b0000000-0000-4000-8000-000000000003",
    contactName: "Carla Ruiz",
    contactPhone: "+51900000003",
    account: "acme",
    firstMessage: "Gracias, quedo atenta",
  },
  {
    id: "c0000000-0000-4000-8000-000000000004",
    contactId: "b0000000-0000-4000-8000-000000000004",
    contactName: "Globex Lead",
    contactPhone: "+51900000004",
    account: "globex",
    firstMessage: "Este hilo pertenece a otra cuenta",
  },
];

export function conversationsFor(account: SeedAccount["key"]): SeedConversation[] {
  return CONVERSATIONS.filter((c) => c.account === account);
}

export function conversationById(id: string): SeedConversation {
  const found = CONVERSATIONS.find((c) => c.id === id);
  if (!found) throw new Error(`No seeded conversation with id "${id}"`);
  return found;
}

/**
 * A well-formed uuid that is deliberately absent from the database.
 * Used by the "conversation was deleted" path, which must land the
 * user back on the inbox with a message rather than on a blank pane.
 */
export const MISSING_CONVERSATION_ID = "c0000000-0000-4000-8000-0000000000ff";
