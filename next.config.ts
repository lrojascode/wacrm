import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Orígenes de Supabase permitidos para XHR, WebSocket y media.
 *
 * Se DERIVAN de `NEXT_PUBLIC_SUPABASE_URL` en vez de escribir
 * `https://*.supabase.co` a mano. La versión anterior lo escribía a
 * mano, y medirlo lo delató: contra un build de producción, cada
 * pantalla de la app disparaba violaciones de `connect-src` — decenas
 * en el inbox y en el dashboard— porque el proyecto local vive en
 * `http://127.0.0.1:54321`. En modo informe nadie se enteraba; el día
 * que se activara el bloqueo, la app se habría quedado sin datos.
 *
 * El mismo comodín habría roto cualquier despliegue con Supabase
 * autoalojado en dominio propio, que es un escenario real de este
 * producto. Derivarlo lo hace correcto en los tres casos: local,
 * gestionado y autoalojado.
 *
 * El WebSocket de realtime necesita su propio esquema: `ws:`/`wss:` no
 * los cubre la entrada `http(s)` aunque el host sea el mismo.
 */
function supabaseOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) {
    // Sin la variable no se puede derivar nada. Se cae al comodín de
    // Supabase gestionado, que es el caso mayoritario, en vez de
    // emitir una política que bloquearía todo.
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
  try {
    const { protocol, host } = new URL(raw);
    const ws = protocol === "https:" ? "wss:" : "ws:";
    return [`${protocol}//${host}`, `${ws}//${host}`];
  } catch {
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
}

const SUPABASE_ORIGINS = supabaseOrigins();
const IS_DEV = process.env.NODE_ENV === "development";

/**
 * Baseline security headers applied to every response.
 *
 * La CSP se aplica en modo BLOQUEO (P0-SEC-10). Estuvo en
 * `Report-Only` durante un tiempo, que es la forma correcta de empezar
 * y una malísima de terminar: no bloquea nada, así que su único valor
 * está en que alguien lea los informes — y nadie los leía. La prueba
 * que autoriza el cambio es `e2e/csp.spec.ts`, que recorre login,
 * inbox con media y realtime, dashboard con gráficos y ajustes, y
 * exige cero violaciones. Corre también contra un build de producción
 * (`E2E_PROD=1`), que es el único sitio donde la ausencia de
 * `unsafe-eval` se puede confirmar.
 *
 * El resto de cabeceras son bloqueos directos, seguros desde siempre:
 *   - HSTS: solo significa algo sobre HTTPS (inocuo en http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     endurecimiento OWASP de base, sin coste de comportamiento.
 *   - Permissions-Policy: no usamos cámara ni geolocalización, así que
 *     se deniegan. Una dependencia comprometida no puede reactivarlas.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // El micrófono se permite para el propio origen (`self`) porque el
    // compositor del inbox graba notas de voz con MediaRecorder. Lo
    // demás sigue denegado.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // `unsafe-inline` sigue aquí porque Next inyecta su propio script
      // de arranque e hidratación en línea. Quitarlo exige CSP por
      // nonce, y eso obliga a renderizar TODAS las páginas de forma
      // dinámica — incluidas las seis que hoy son estáticas (login,
      // signup, /mfa, recuperación de contraseña). Peor: un nonce en
      // una página cacheada por el CDN se comparte entre visitantes y
      // deja de ser un nonce, así que habría que rehacer también las
      // reglas de Cache-Control de abajo. Es un proyecto aparte, no un
      // ajuste; queda anotado en la spec con ese motivo.
      //
      // `unsafe-eval` SOLO en desarrollo: React lo usa allí para
      // reconstruir stacks de error del servidor. En producción ni
      // React ni Next lo necesitan, así que no se concede — verificado
      // contra un build real, no supuesto.
      `script-src 'self' 'unsafe-inline'${IS_DEV ? " 'unsafe-eval'" : ""}`,
      // Tailwind y los atributos `style` en línea de 25 componentes,
      // más los que genera Recharts al dibujar.
      "style-src 'self' 'unsafe-inline'",
      // Avatares del bucket público, avatares de contacto (URLs https
      // arbitrarias que se pegan desde la UI), imágenes OG y data: URLs
      // para el QR del segundo factor (P0-SEC-09).
      "img-src 'self' data: blob: https:",
      // Previsualización de media saliente (blob: de MediaRecorder y
      // del selector de archivos) y el audio/vídeo del bucket que
      // pinta el inbox.
      `media-src 'self' blob: ${SUPABASE_ORIGINS[0]}`,
      "font-src 'self' data:",
      // REST + realtime. Las llamadas a la API de Meta salen del
      // servidor, así que graph.facebook.com no pinta nada aquí.
      `connect-src 'self' ${SUPABASE_ORIGINS.join(" ")}`,
      // No usamos <object>, <embed> ni <applet>. `default-src 'self'`
      // los permitiría del propio origen; 'none' cierra del todo una
      // vía clásica de inyección.
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — public, brief s-maxage + generous
   *     stale-while-revalidate. The edge serves instantly from cache
   *     for the first 5 min, then returns cached content while
   *     refreshing in the background for up to 24 h. A deploy's
   *     chunk-hash drift self-heals within ~5 min with no user-
   *     visible latency.
   *
   *   - Authenticated app routes — private, no-store. See the rule's
   *     own comment below; this one is a correctness requirement, not
   *     a tuning knob.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // Authenticated app HTML must never enter a shared cache.
        //
        // This overrides the blanket `public, s-maxage=300` above —
        // later rules win, because Next assigns headers by key in array
        // order (server/lib/router-utils/resolve-routes).
        //
        // An earlier version of the comment above claimed Next.js and
        // the auth proxy already force `private` / `no-store` on
        // per-user responses. Neither does. Next only applies its own
        // cache-control when the header is not already set
        // (server/send-payload.js: "If cache control is already set on
        // the response we don't override it"), and src/proxy.ts
        // never touches Cache-Control at all — so the rule above was
        // winning on every dashboard page.
        //
        // That was harmless only while the dashboard shell rendered
        // identically for everyone. It stopped being harmless when the
        // account's brand name and logo moved into the server-rendered
        // <head> (generateMetadata in src/app/(dashboard)/layout.tsx):
        // a shared cache could then hand one customer another
        // customer's branding for up to 5 minutes, and up to 24 h while
        // revalidating. Do not relax this without moving branding back
        // out of the server-rendered head.
        //
        // Written as a negative lookahead rather than a list of app
        // routes so it fails closed: a new route is private until
        // someone deliberately exempts it. The exempted paths are the
        // genuinely public ones — auth screens, invite acceptance, and
        // the tracked-link redirect.
        //
        // Verify this against a PRODUCTION build (`next build && next
        // start`), never `next dev`. In dev, base-server.js overwrites
        // Cache-Control with "no-cache, must-revalidate" on every page
        // unconditionally (`if (this.dev)`), which hides this rule and
        // makes it look like it never applied.
        source: "/:path((?!_next/|api/|login|signup|forgot-password|join/|l/).+)",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
