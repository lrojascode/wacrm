// ============================================================
// Resolving `/inbox/<id>` to a conversation the caller may actually
// see (P0-BUG-05, defect D).
//
// Before this, the id in the URL was matched against whatever the
// conversation list happened to have loaded. If it was not there —
// deleted, filtered out, on a later page, or belonging to a different
// account — nothing happened at all: no selection, no error, no
// redirect. The user opened their link and got an empty pane with no
// explanation.
//
// WHY "not found" AND "forbidden" ARE ONE OUTCOME
//
// The plan called for three distinguishable states. Two of them are not
// distinguishable, and deliberately so: RLS returns zero rows for
// another account's conversation exactly as it does for one that no
// longer exists. Telling them apart would take a service-role read that
// deliberately looks past the tenant boundary, and it would turn this
// route into an oracle — paste an id, learn whether it is a real
// conversation in someone else's account. An ex-employee who still has
// old links is precisely the person that answer would help.
//
// So the caller gets `unavailable` for both, which is also what the bug
// report asked for: "si la conversación fue eliminada o el usuario
// perdió acceso, regresar a Inbox con un mensaje claro" — one message,
// covering both.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_SELECT, normalizeConversation } from "@/lib/inbox/conversations";
import type { Conversation } from "@/types";

export type ConversationResolution =
  /** Exists and the caller may see it. */
  | { status: "ok"; conversation: Conversation }
  /** Deleted, or belongs to another account. Indistinguishable — see above. */
  | { status: "unavailable" }
  /**
   * The lookup itself failed (network, transport). NOT the same as
   * "unavailable": redirecting away on a failed request would throw the
   * user out of a conversation they can perfectly well see, which is
   * the same class of mistake P0-BUG-03 fixed for sign-outs.
   */
  | { status: "error"; message: string }
  /**
   * There is no live session, so "no rows" means nothing about the
   * conversation.
   *
   * Without this case the resolver mistakes a dying session for a
   * deleted conversation: RLS returns zero rows with NO error when
   * `auth.uid()` is null, which is indistinguishable from a genuinely
   * inaccessible row. The user would then be told "this conversation is
   * no longer available" — wrong, and worse, they would be bounced to
   * /inbox first, so the `?next=` recorded a moment later on the way to
   * /login pointed at the list instead of the conversation they were
   * reading. Signing back in would not return them to it.
   *
   * Callers must do nothing on this: the auth layer owns the outcome.
   */
  | { status: "unauthenticated" };

/**
 * Look up one conversation as the signed-in user.
 *
 * `client` must be the browser (anon-key) client, never the service
 * role: RLS is what makes this safe, and bypassing it would return
 * other accounts' rows.
 */
export async function resolveConversation(
  client: SupabaseClient,
  conversationId: string,
): Promise<ConversationResolution> {
  try {
    const { data, error } = await client
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("id", conversationId)
      .maybeSingle();

    if (error) {
      // Supabase errors carry non-enumerable properties, so a bare
      // template literal renders as "{}". Pull the message out.
      return { status: "error", message: error.message ?? "unknown error" };
    }

    if (!data) {
      // Confirm there is still a session before believing the empty
      // result — the same "confirm before acting" rule the sign-out
      // path follows (P0-BUG-03), for the same reason.
      const { data: userData } = await client.auth.getUser();
      if (!userData?.user) return { status: "unauthenticated" };
      return { status: "unavailable" };
    }

    return { status: "ok", conversation: normalizeConversation(data) };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "unknown error",
    };
  }
}

/**
 * Is this string shaped like a conversation id?
 *
 * A malformed id makes PostgREST reject the query with a 22P02 cast
 * error, which would surface as `error` and leave the user staring at
 * a conversation that never loads. Catching it up front turns a
 * hand-edited URL into the same clean "unavailable" as any other id
 * that does not resolve.
 */
export function looksLikeConversationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
