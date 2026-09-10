"use client";

// ============================================================
// /mfa — inscribir el segundo factor, o superar el reto (P0-SEC-09).
//
// Una sola página con dos estados porque son dos mitades de lo mismo,
// y separarlas obliga a quien llega a saber en cuál está:
//
//   sin factor verificado  → inscribir (QR + confirmar con un código)
//   con factor, en aal1    → reto (solo el código)
//
// TODO OCURRE CONTRA SUPABASE, NO CONTRA ESTA APP
//
// `supabase.auth.mfa.*` va del navegador a Supabase directamente. Es
// deliberado y además es lo que hace imposible el punto muerto: si
// inscribirse pasara por una ruta de configuración de esta app, haría
// falta aal2 para llegar a aal2. Aquí el servidor solo EXIGE; el
// navegador INSCRIBE.
//
// Vive en el grupo (auth) y no en el dashboard por la misma razón: el
// shell del dashboard es lo que redirige aquí, así que alojarla dentro
// sería un bucle.
// ============================================================

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_SIGNED_IN_PATH, sanitizeNextPath } from "@/lib/auth/next-path";

type Phase = "loading" | "enroll" | "challenge" | "done";

interface EnrollData {
  factorId: string;
  qr: string;
  secret: string;
}

// `useSearchParams` saca al componente del prerender estático si no va
// envuelto en Suspense — mismo patrón que /login y /signup. Sin esto
// el build falla al exportar /mfa.
export default function MfaPage() {
  return (
    <Suspense fallback={null}>
      <MfaPageInner />
    </Suspense>
  );
}

function MfaPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [phase, setPhase] = useState<Phase>("loading");
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const destination =
    sanitizeNextPath(searchParams.get("next")) ?? DEFAULT_SIGNED_IN_PATH;

  // Decide en qué mitad estamos y, si toca inscribir, prepara el QR.
  //
  // La IIFE asíncrona con bandera `cancelled` va dentro del efecto en
  // vez de un useCallback que el efecto invoque: la regla
  // `react-hooks/set-state-in-effect` de este repo lee esa segunda
  // forma como setState síncrono dentro del efecto. Es el mismo patrón
  // que use-mfa-gate.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listErr) {
        setError(listErr.message);
        setPhase("enroll");
        return;
      }

      const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");
      if (verified.length > 0) {
        setPhase("challenge");
        return;
      }

      // Los factores a medio inscribir se acumulan si alguien abandona
      // la página a mitad; Supabase tiene un tope por usuario, y
      // llegar a él deja a la persona sin poder inscribir nada. Se
      // limpian antes de crear el siguiente.
      for (const stale of factors?.totp ?? []) {
        await supabase.auth.mfa.unenroll({ factorId: stale.id }).catch(() => {});
      }
      if (cancelled) return;

      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `app-${Date.now()}`,
      });
      if (cancelled) return;
      if (enrollErr || !data) {
        setError(enrollErr?.message ?? "No se pudo iniciar la inscripción");
        setPhase("enroll");
        return;
      }
      setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setPhase("enroll");
    })();

    return () => {
      cancelled = true;
    };
    // `supabase` es un cliente nuevo por render; incluirlo reinscribiría
    // en bucle. La inscripción debe correr una vez por montaje.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setBusy(true);

      // El mismo par challenge+verify sirve para las dos mitades: al
      // inscribir confirma que la app del usuario genera códigos
      // válidos, y en el reto sube la sesión a aal2.
      let factorId = enroll?.factorId;
      if (!factorId) {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        factorId = (factors?.totp ?? []).find((f) => f.status === "verified")?.id;
      }
      if (!factorId) {
        setError("No hay ningún factor con el que continuar.");
        setBusy(false);
        return;
      }

      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: code.trim(),
      });
      if (verifyErr) {
        setError(verifyErr.message);
        setBusy(false);
        return;
      }

      setPhase("done");
      // Recarga entera y no router.push: la sesión acaba de subir a
      // aal2 y el token nuevo tiene que llegar al servidor en la
      // siguiente petición, o el shell rebotaría aquí otra vez.
      window.location.href = destination;
    },
    [code, destination, enroll?.factorId, supabase],
  );

  if (phase === "loading" || phase === "done") {
    return (
      <Shell>
        <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </CardContent>
      </Shell>
    );
  }

  const enrolling = phase === "enroll";

  return (
    <Shell>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          {enrolling ? (
            <ShieldAlert className="h-6 w-6 text-primary" />
          ) : (
            <ShieldCheck className="h-6 w-6 text-primary" />
          )}
        </div>
        <CardTitle className="text-xl text-foreground">
          {enrolling ? "Protege tu cuenta" : "Introduce tu código"}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {enrolling
            ? "La configuración y las credenciales de la cuenta necesitan un segundo factor. Escanea el código con tu app de autenticación."
            : "Abre tu app de autenticación y escribe el código de seis dígitos."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error && (
            <div
              data-testid="mfa-error"
              className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
            >
              {error}
            </div>
          )}

          {enrolling && enroll && (
            <div className="flex flex-col items-center gap-3">
              {/* `<img>` y no `next/image` a propósito: Supabase
                  devuelve el QR como un data: URI con un SVG dentro, y
                  next/image lo rechaza en tiempo de ejecución
                  («Image with src "data:image/svg+xml;utf-8,…"»), así
                  que la página de inscripción se rompía justo para
                  quien más la necesita. Tampoco hay nada que optimizar:
                  el SVG ya viaja dentro del HTML, sin petición de red. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enroll.qr}
                alt="Código QR para la app de autenticación"
                width={180}
                height={180}
                className="rounded-lg bg-white p-2"
              />
              <details className="w-full text-center text-xs text-muted-foreground">
                {/* Para quien no pueda escanear: teclado, lector de
                    pantalla, o un escritorio sin cámara. */}
                <summary className="cursor-pointer">
                  ¿No puedes escanear? Introduce la clave a mano
                </summary>
                <code
                  data-testid="mfa-secret"
                  className="mt-2 block break-all rounded bg-muted px-2 py-1 font-mono"
                >
                  {enroll.secret}
                </code>
              </details>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="code" className="text-muted-foreground">
              Código de seis dígitos
            </Label>
            <Input
              id="code"
              data-testid="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              className="border-border bg-muted text-center font-mono text-lg tracking-widest text-foreground"
            />
          </div>

          <Button
            type="submit"
            disabled={busy || code.length < 6}
            data-testid="mfa-submit"
            className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "Comprobando…" : enrolling ? "Activar" : "Continuar"}
          </Button>
        </form>

        <button
          type="button"
          onClick={async () => {
            await supabase.auth.signOut();
            router.push("/login");
          }}
          className="mt-6 w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Cerrar sesión
        </button>
      </CardContent>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">{children}</Card>
    </div>
  );
}
