// ============================================================
// P0-SEC-04 — the header-image fetch, as an attacker would aim it.
//
// Kept apart from template-header-handle.test.ts on purpose. That file
// holds the SSRF guard open so it can ask about the rest of the
// contract; this one runs the guard for real. If the helper ever stops
// consulting it, only this file goes red, and the failure names the
// reason instead of one of a dozen unrelated expectations.
//
// Almost nothing here needs DNS: every rejected host is either a
// literal IP or one of the names the guard short-circuits. The single
// exception is the `.invalid` name in the oracle test, which RFC 2606
// guarantees will never resolve — and which fails the same way on a
// machine with no network at all.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

import { ensureImageHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

const MB = 1024 * 1024;

function payload(url: string): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: url,
  };
}

beforeEach(() => {
  vi.stubEnv('META_APP_ID', 'app-1');
  vi.mocked(uploadResumableMedia).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SSRF · una URL interna se rechaza sin abrir conexión', () => {
  // "Sin abrir conexión" es la mitad que importa. Un rechazo *después*
  // de conectar ya ha entregado el ataque: el servicio interno recibió
  // la petición, y el atacante puede leer la diferencia entre un error
  // rápido y uno lento como respuesta. Por eso cada caso comprueba que
  // `fetch` no llegó a llamarse.
  const INTERNAL = [
    ['metadatos de la nube', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback por IP', 'https://127.0.0.1/img.jpg'],
    ['loopback por nombre', 'https://localhost:54321/storage/v1/object/x.jpg'],
    ['red privada RFC1918', 'https://10.0.0.1/img.jpg'],
    ['red privada 192.168', 'https://192.168.1.1/img.jpg'],
    ['nombre interno', 'https://vault.internal/img.jpg'],
    ['mDNS', 'https://printer.local/img.jpg'],
    ['loopback IPv6', 'https://[::1]/img.jpg'],
  ] as const;

  for (const [label, url] of INTERNAL) {
    it(`rechaza ${label}`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(ensureImageHeaderHandle(payload(url), 'tok')).rejects.toThrow(
        /publicly reachable host/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('rechaza http:// aunque el host sea público', async () => {
    // Sin esto, `http://` a un host público sigue siendo texto plano por
    // la red y, peor, un salto trivial hacia proxies internos que solo
    // hablan HTTP.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(ensureImageHeaderHandle(payload('http://8.8.8.8/img.jpg'), 'tok')).rejects.toThrow(
      /must be an https:\/\/ URL/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rechaza esquemas que ni siquiera son HTTP', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      ensureImageHeaderHandle(payload('file:///etc/passwd'), 'tok'),
    ).rejects.toThrow(/https:\/\/ URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rechaza una URL malformada', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(ensureImageHeaderHandle(payload('no-es-una-url'), 'tok')).rejects.toThrow(
      /not a valid URL/,
    );
  });

  it('no distingue "privada" de "no resuelve"', async () => {
    // Dos mensajes distintos convertirían el error en un oráculo para
    // mapear la red interna: probar nombres y leer cuál "existe".
    vi.stubGlobal('fetch', vi.fn());

    const privateErr = await ensureImageHeaderHandle(
      payload('https://10.1.2.3/x.jpg'),
      'tok',
    ).catch((e: Error) => e.message);
    const unresolvableErr = await ensureImageHeaderHandle(
      payload('https://este-nombre-no-existe.invalid/x.jpg'),
      'tok',
    ).catch((e: Error) => e.message);

    expect(privateErr).toBe(unresolvableErr);
  });
});

describe('SSRF · una redirección no puede saltar a la red interna', () => {
  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it('rechaza un salto público → IP privada', async () => {
    // El caso que hace obligatorio `redirect: "manual"`. Con el
    // seguimiento automático de fetch, la validación inicial mira el
    // host público y la petición acaba en el privado.
    vi.stubGlobal('fetch', vi.fn(async () => redirectTo('https://169.254.169.254/latest/')));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/redirect target must point at a publicly reachable host/);
  });

  it('rechaza un salto que degrada a http://', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirectTo('http://8.8.8.8/img.jpg')));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/redirect target must be an https:\/\/ URL/);
  });

  it('resuelve un Location relativo contra el salto actual', async () => {
    // Un `Location: /interno` relativo se queda en el mismo host, que ya
    // pasó el guard. Debe seguir funcionando: romperlo rompería CDNs
    // reales sin ganar seguridad.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('/real/img.jpg'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(64), { headers: { 'content-type': 'image/jpeg' } }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const p = payload('https://8.8.8.8/img.jpg');
    await ensureImageHeaderHandle(p, 'tok');

    expect(p.header_handle).toBe('HANDLE123');
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://8.8.8.8/real/img.jpg');
  });

  it('corta una cadena de redirecciones infinita', async () => {
    const fetchSpy = vi.fn(async () => redirectTo('https://8.8.8.8/otra-vez'));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/redirected more than/);
    // Acotado, no infinito: el intento inicial más los saltos permitidos.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('rechaza una redirección sin destino', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/without a destination/);
  });
});

describe('memoria · el límite de 5 MB acota la reserva, no la describe', () => {
  /**
   * Un cuerpo que no se acaba, que además cuenta lo que llegó a
   * producir. Ese contador es la prueba: si el lector abandonara solo
   * al final, habría producido los 100 MB enteros.
   */
  function endlessBody(headers: Record<string, string> = {}) {
    const CHUNK = 1 * MB;
    const CEILING = 100 * MB;
    let produced = 0;
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= CEILING) {
          controller.close();
          return;
        }
        produced += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });

    return {
      response: new Response(stream, {
        headers: { 'content-type': 'image/jpeg', ...headers },
      }),
      produced: () => produced,
      cancelled: () => cancelled,
    };
  }

  it('abandona un cuerpo de 100 MB nada más pasar el límite', async () => {
    const body = endlessBody();
    vi.stubGlobal('fetch', vi.fn(async () => body.response));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/5 MB/);

    expect(body.cancelled()).toBe(true);
    // El viejo código llegaba a los 100 MB antes de comparar. Se deja
    // holgura de un par de trozos por el encolado interno del stream,
    // pero el orden de magnitud es el que decide.
    expect(body.produced()).toBeLessThan(10 * MB);
    expect(uploadResumableMedia).not.toHaveBeenCalled();
  });

  it('rechaza por Content-Length antes de tocar el cuerpo', async () => {
    const body = endlessBody({ 'content-length': String(100 * MB) });
    vi.stubGlobal('fetch', vi.fn(async () => body.response));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/5 MB/);

    // No es cero, y la razón es del doble, no del código: un
    // ReadableStream con la estrategia por defecto ya pide su primer
    // trozo al construirse, antes de que nadie lo lea. Lo que se afirma
    // es que el código nunca pidió un segundo — un solo trozo significa
    // que no llegó a leer nada, frente a los ~6 del caso de arriba.
    expect(body.produced()).toBeLessThanOrEqual(MB);
    expect(body.cancelled()).toBe(true);
  });

  it('un Content-Length que miente no sirve para colar bytes de más', async () => {
    // La cabecera es del atacante igual que la URL. Declarar 1 KB y
    // enviar 100 MB debe acabar igual que declarar la verdad.
    const body = endlessBody({ 'content-length': '1024' });
    vi.stubGlobal('fetch', vi.fn(async () => body.response));

    await expect(
      ensureImageHeaderHandle(payload('https://8.8.8.8/img.jpg'), 'tok'),
    ).rejects.toThrow(/5 MB/);

    expect(body.produced()).toBeLessThan(10 * MB);
  });

  it('una imagen pública y válida sigue pasando', async () => {
    // El contrapeso. Sin esto, la suite entera pasaría con un guard que
    // rechazara absolutamente todo.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(4 * MB), { headers: { 'content-type': 'image/png' } }),
      ),
    );

    const p = payload('https://8.8.8.8/img.png');
    await ensureImageHeaderHandle(p, 'tok');

    expect(p.header_handle).toBe('HANDLE123');
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/png', fileName: 'header.png' }),
    );
  });
});
