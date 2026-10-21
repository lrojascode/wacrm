// Test-process transport only: never imported by application source/builds.
import { randomUUID } from 'node:crypto';
const originalFetch = globalThis.fetch;
if (process.env.E2E_PROVIDER_MOCKS === '1') {
  globalThis.fetch = async function (input, init) {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url
    );
    const local = [
      'localhost',
      '127.0.0.1',
      '[::1]',
      'host.docker.internal',
    ].includes(url.hostname);
    if (local) return originalFetch(input, init);
    const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (
      !supabase ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(supabase).hostname)
    )
      throw new Error('Provider doubles require a loopback Supabase');
    if (url.hostname === 'graph.facebook.com') {
      return Response.json({
        messaging_product: 'whatsapp',
        messages: [{ id: `wamid.e2e.${randomUUID()}` }],
        data: [],
      });
    }
    if (url.hostname === 'api.openai.com') {
      return Response.json({
        choices: [{ message: { content: 'Borrador IA de prueba local' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (url.hostname === 'api.anthropic.com') {
      return Response.json({
        content: [{ type: 'text', text: 'Borrador IA de prueba local' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }
    throw new Error(
      `External request blocked by E2E transport: ${url.hostname}`
    );
  };
}
