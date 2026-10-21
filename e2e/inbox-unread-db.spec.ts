import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { inboxFixture, signedClient, sqlClient } from './support/inbox';

// SQL behavior is independent of browser: run once, not once per viewport.
test.beforeEach(({}, info) =>
  test.skip(info.project.name !== 'desktop-chromium')
);

test('legacy read-modify-write loses an increment on real Postgres', async ({}, info) => {
  const a = await sqlClient();
  const b = await sqlClient();
  const table = `e2e_unread_${randomUUID().replaceAll('-', '')}`;
  try {
    await a.query(
      `CREATE TABLE public.${table}(unread_count integer); INSERT INTO public.${table} VALUES (0)`
    );
    // Explicit barrier: both requests have read the same N before either writes.
    const [first, second] = await Promise.all([
      a.query(`SELECT unread_count FROM public.${table}`),
      b.query(`SELECT unread_count FROM public.${table}`),
    ]);
    await a.query(`UPDATE public.${table} SET unread_count=$1`, [
      first.rows[0].unread_count + 1,
    ]);
    await b.query(`UPDATE public.${table} SET unread_count=$1`, [
      second.rows[0].unread_count + 1,
    ]);
    const result = await a.query(`SELECT unread_count FROM public.${table}`);
    expect(result.rows[0].unread_count).toBe(1);
    await info.attach('legacy-sql-race', {
      body: JSON.stringify({
        reads: [0, 0],
        expectedWithoutLoss: 2,
        observed: 1,
      }),
      contentType: 'application/json',
    });
  } finally {
    await a.query(`DROP TABLE IF EXISTS public.${table}`);
    await a.end();
    await b.end();
  }
});

test('parallel incoming messages count exactly; outgoing, duplicate and status events do not', async () => {
  const fixture = await inboxFixture();
  try {
    const messages = await Promise.all(
      Array.from({ length: 12 }, () => fixture.message())
    );
    expect((await fixture.state()).unread_count).toBe(12);
    await fixture.message({ sender_type: 'agent' });
    await fixture.message({ sender_type: 'bot' });
    await fixture.message({ content_type: 'call', call_outcome: 'accepted' });
    await fixture.message({ content_type: 'call', call_outcome: 'missed' });
    expect((await fixture.state()).unread_count).toBe(13);
    const key = `wamid.${randomUUID()}`;
    const deliveries = await Promise.allSettled([
      fixture.message({ message_id: key }),
      fixture.message({ message_id: key }),
    ]);
    expect(
      deliveries.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect((await fixture.state()).unread_count).toBe(14);
    const before = await fixture.state();
    const update = await fixture.admin
      .from('messages')
      .update({ status: 'read' })
      .eq('id', messages[0].id);
    expect(update.error).toBeNull();
    expect(await fixture.state()).toEqual(before);
    // Simulate old webhook and browser resets. Neither can corrupt the aggregate.
    await fixture.admin
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', fixture.id);
    expect(await fixture.state()).toEqual(before);
  } finally {
    await fixture.cleanup();
  }
});

test('two agents acknowledge idempotently and preserve a concurrent backdated message', async ({}, info) => {
  const fixture = await inboxFixture();
  const tx = await sqlClient();
  const alice = await signedClient();
  const bob = await signedClient('acmeAgentTwo');
  try {
    const first = await fixture.message();
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: alice.user.id, role: 'authenticated' }),
    ]);
    await tx.query('SET LOCAL ROLE authenticated');
    await tx.query('SELECT public.acknowledge_inbox_messages($1, $2)', [
      fixture.id,
      [first.id],
    ]);
    const incoming = fixture.message({ created_at: '2020-01-01T00:00:00Z' });
    // Observe a genuinely blocked statement, rather than guessing with a sleep.
    const observer = await sqlClient();
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await observer.query(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%messages%' AND pid <> pg_backend_pid()"
              )
            ).rows[0].count
          )
        )
        .toBeGreaterThan(0);
    } finally {
      await observer.end();
    }
    await tx.query('COMMIT');
    const next = await incoming;
    const responses = await Promise.all(
      [alice.client, bob.client].map((client) =>
        client.rpc('acknowledge_inbox_messages', {
          p_conversation_id: fixture.id,
          p_message_ids: [first.id, first.id],
        })
      )
    );
    expect(responses.every((response) => !response.error)).toBe(true);
    expect((await fixture.state()).unread_count).toBe(1);
    const pending = await fixture.admin
      .from('messages')
      .select('id')
      .eq('conversation_id', fixture.id)
      .eq('inbox_unread', true);
    expect(pending.data).toEqual([{ id: next.id }]);
    const before = await fixture.state();
    await bob.client.rpc('acknowledge_inbox_messages', {
      p_conversation_id: fixture.id,
      p_message_ids: [first.id],
    });
    expect(await fixture.state()).toEqual(before);
    await info.attach('concurrent-receipt', {
      body: JSON.stringify({ persisted: before, unreadIds: pending.data }),
      contentType: 'application/json',
    });
  } finally {
    await tx.query('ROLLBACK');
    await tx.end();
    await fixture.cleanup();
  }
});

test('viewer, anonymous and another tenant cannot acknowledge', async () => {
  const fixture = await inboxFixture();
  try {
    const message = await fixture.message();
    for (const key of ['acmeViewer', 'globexOwner']) {
      const { client } = await signedClient(key);
      const result = await client.rpc('acknowledge_inbox_messages', {
        p_conversation_id: fixture.id,
        p_message_ids: [message.id],
      });
      expect(result.error?.code).toBe('42501');
    }
    const db = await sqlClient();
    try {
      const result = await db.query(
        "SELECT has_function_privilege('anon','public.acknowledge_inbox_messages(uuid,uuid[])','EXECUTE') AS allowed"
      );
      expect(result.rows[0].allowed).toBe(false);
    } finally {
      await db.end();
    }
    expect((await fixture.state()).unread_count).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test('backfill preserves N, reapplication preserves acknowledgements, impossible counters abort', async () => {
  const fixture = await inboxFixture();
  const db = await sqlClient();
  const script = readFileSync(
    'supabase/migrations/054_inbox_read_state.sql',
    'utf8'
  )
    .replace(/^BEGIN;$/m, '')
    .replace(/^COMMIT;$/m, '');
  try {
    const one = await fixture.message();
    await fixture.message();
    await db.query('BEGIN');
    // Reconstruct the pre-054 state inside a rolled-back local transaction.
    await db.query(`DROP TRIGGER inbox_message_update ON messages; DROP TRIGGER inbox_message_insert ON messages; DROP TRIGGER inbox_message_delete ON messages;
      UPDATE messages SET inbox_unread=false WHERE conversation_id='${fixture.id}';
      UPDATE conversations SET unread_count=1 WHERE id='${fixture.id}'; DELETE FROM schema_release WHERE version='054';`);
    await db.query(script);
    expect(
      Number(
        (
          await db.query(
            'SELECT count(*) FROM messages WHERE conversation_id=$1 AND inbox_unread',
            [fixture.id]
          )
        ).rows[0].count
      )
    ).toBe(1);
    await db.query(
      'UPDATE messages SET inbox_unread=false WHERE conversation_id=$1',
      [fixture.id]
    );
    await db.query(script);
    expect(
      (
        await db.query('SELECT unread_count FROM conversations WHERE id=$1', [
          fixture.id,
        ])
      ).rows[0].unread_count
    ).toBe(0);
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    await db.query('UPDATE conversations SET unread_count=999999 WHERE id=$1', [
      fixture.id,
    ]);
    await db.query("DELETE FROM schema_release WHERE version='054'");
    await expect(db.query(script)).rejects.toThrow('cannot be reconciled');
    await db.query('ROLLBACK');
    expect((await fixture.state()).unread_count).toBe(2);
    expect(one.id).toBeTruthy();
  } finally {
    await db.query('ROLLBACK');
    await db.end();
    await fixture.cleanup();
  }
});

test('contact merges carry per-message read state and preserve the aggregate', async () => {
  const first = await inboxFixture();
  const second = await inboxFixture();
  const db = await sqlClient();
  const agent = await signedClient();
  try {
    const read = await first.message();
    await second.message();
    const receipt = await agent.client.rpc('acknowledge_inbox_messages', {
      p_conversation_id: first.id,
      p_message_ids: [read.id],
    });
    expect(receipt.error).toBeNull();
    await db.query('SELECT public.merge_contact_group($1)', [
      [first.contactId, second.contactId],
    ]);
    const rows = await db.query(
      'SELECT id, unread_count FROM public.conversations WHERE contact_id = ANY($1)',
      [[first.contactId, second.contactId]]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].unread_count).toBe(1);
    const pending = await db.query(
      'SELECT count(*) FROM public.messages WHERE conversation_id=$1 AND inbox_unread',
      [rows.rows[0].id]
    );
    expect(Number(pending.rows[0].count)).toBe(1);
  } finally {
    await db.end();
    await first.cleanup();
    await second.cleanup();
  }
});
