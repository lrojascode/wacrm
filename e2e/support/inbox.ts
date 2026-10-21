import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from './seed';
import { E2E_PASSWORD, userByKey } from './fixtures';

export function assertLocal(url: string) {
  if (
    ![
      'localhost',
      '127.0.0.1',
      '[::1]',
      '::1',
      'host.docker.internal',
    ].includes(new URL(url).hostname)
  )
    throw new Error(
      'Inbox fixtures require a local target; no remote override is allowed'
    );
}
export async function sqlClient() {
  const connectionString =
    process.env.E2E_DB_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  assertLocal(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
export async function signedClient(key = 'acmeAgent') {
  assertLocal(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: userByKey(key).email,
    password: E2E_PASSWORD,
  });
  if (error) throw error;
  return { client, user: data.user! };
}
export async function inboxFixture(name = `Inbox regression ${randomUUID()}`) {
  const admin = createAdminClient();
  const { data: owner, error: ownerError } = await admin
    .from('profiles')
    .select('user_id, account_id')
    .eq('email', userByKey('acmeOwner').email)
    .single();
  if (ownerError) throw ownerError;
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const { error: contactError } = await admin.from('contacts').insert({
    id: contactId,
    account_id: owner.account_id,
    user_id: owner.user_id,
    name,
    phone: '',
  });
  if (contactError) throw contactError;
  const { error } = await admin.from('conversations').insert({
    id: conversationId,
    contact_id: contactId,
    account_id: owner.account_id,
    user_id: owner.user_id,
    status: 'open',
    last_message_at: new Date().toISOString(),
  });
  if (error) throw error;
  return {
    admin,
    id: conversationId,
    contactId,
    accountId: owner.account_id,
    name,
    async message(overrides: Record<string, unknown> = {}) {
      const { data, error } = await admin
        .from('messages')
        .insert({
          id: randomUUID(),
          conversation_id: conversationId,
          sender_type: 'customer',
          content_type: 'text',
          content_text: `Incoming ${randomUUID()}`,
          status: 'delivered',
          ...overrides,
        })
        .select('*')
        .single();
      if (error) throw error;
      // Match the real inbound/outbound pipelines: the persisted preview
      // also lets a post-subscription resync recover an earlier INSERT.
      const preview = await admin
        .from('conversations')
        .update({
          last_message_text: data.content_text,
          last_message_at: data.created_at,
        })
        .eq('id', conversationId);
      if (preview.error) throw preview.error;
      return data;
    },
    async state() {
      const { data, error } = await admin
        .from('conversations')
        .select('unread_count, unread_revision')
        .eq('id', conversationId)
        .single();
      if (error) throw error;
      return data;
    },
    async cleanup() {
      const { error } = await admin
        .from('contacts')
        .delete()
        .eq('id', contactId);
      if (error) throw error;
    },
  };
}

/** Synthetic provider credentials only, against the locally guarded fixture. */
export async function providerFixture(
  fixture: Awaited<ReturnType<typeof inboxFixture>>
) {
  const { encrypt } = await import('../../src/lib/whatsapp/encryption');
  const { data: owner, error } = await fixture.admin
    .from('profiles')
    .select('user_id')
    .eq('email', userByKey('acmeOwner').email)
    .single();
  if (error) throw error;
  for (const operation of [
    fixture.admin
      .from('contacts')
      .update({ phone: `+569${String(Date.now()).slice(-8)}` })
      .eq('id', fixture.contactId),
    fixture.admin.from('whatsapp_config').upsert(
      {
        account_id: fixture.accountId,
        user_id: owner.user_id,
        phone_number_id: 'e2e-phone-number',
        webhook_token: randomUUID().replaceAll('-', ''),
        access_token: encrypt('e2e-not-a-real-token'),
        status: 'connected',
      },
      { onConflict: 'account_id' }
    ),
    fixture.admin.from('ai_configs').upsert(
      {
        account_id: fixture.accountId,
        provider: 'openai',
        model: 'e2e-model',
        api_key: encrypt('e2e-not-a-real-key'),
        is_active: true,
        auto_reply_enabled: false,
      },
      { onConflict: 'account_id' }
    ),
  ]) {
    const result = await operation;
    if (result.error) throw result.error;
  }
  const templateId = randomUUID();
  const replyId = randomUUID();
  const template = await fixture.admin.from('message_templates').insert({
    id: templateId,
    account_id: fixture.accountId,
    user_id: owner.user_id,
    name: `e2e_${templateId.replaceAll('-', '')}`,
    category: 'Utility',
    language: 'es',
    body_text: 'Plantilla de prueba local',
    status: 'APPROVED',
  });
  if (template.error) throw template.error;
  const reply = await fixture.admin.from('quick_replies').insert({
    id: replyId,
    account_id: fixture.accountId,
    user_id: owner.user_id,
    title: `Respuesta ${replyId}`,
    kind: 'text',
    content_text: 'Respuesta rápida local',
  });
  if (reply.error) throw reply.error;
  return {
    templateName: `e2e_${templateId.replaceAll('-', '')}`,
    replyTitle: `Respuesta ${replyId}`,
    async cleanup() {
      await fixture.admin
        .from('message_templates')
        .delete()
        .eq('id', templateId);
      await fixture.admin.from('quick_replies').delete().eq('id', replyId);
      await fixture.admin
        .from('whatsapp_config')
        .delete()
        .eq('account_id', fixture.accountId);
      await fixture.admin
        .from('ai_configs')
        .delete()
        .eq('account_id', fixture.accountId);
    },
  };
}
