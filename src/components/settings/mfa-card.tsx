'use client';

// ============================================================
// Segundo factor — opcional, y se activa aquí.
//
// La versión anterior lo imponía a todo admin y owner, y el día del
// despliegue dejó al owner del proyecto delante de un QR sin más salida
// que escanearlo. Ahora es una decisión de cada persona: quien no lo
// active entra con normalidad.
//
// La inscripción vive en /mfa (QR, clave manual y verificación), así
// que esta tarjeta no la duplica: enseña el estado y lleva allí. Una
// segunda implementación del mismo flujo es una segunda oportunidad de
// que se desincronicen.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export function MfaCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await createClient().auth.mfa.listFactors();
    if (error) {
      setEnabled(false);
      return;
    }
    setEnabled((data?.totp ?? []).some((f) => f.status === 'verified'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disable = async () => {
    setWorking(true);
    try {
      const supabase = createClient();
      const { data, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) throw new Error(listErr.message);

      for (const factor of data?.totp ?? []) {
        const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        // Desinscribir un factor verificado exige aal2. Quien está aquí
        // ya lo superó al entrar, así que un fallo es real y se dice.
        if (error) throw new Error(error.message);
      }
      setEnabled(false);
      setConfirming(false);
      toast.success('Segundo factor desactivado');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'No se pudo desactivar el segundo factor',
      );
    }
    setWorking(false);
  };

  return (
    <>
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            {enabled ? (
              <ShieldCheck className="h-4 w-4 text-primary" />
            ) : (
              <ShieldOff className="h-4 w-4 text-muted-foreground" />
            )}
            Verificación en dos pasos
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {enabled
              ? 'Activada. Al iniciar sesión te pediremos el código de tu app de autenticación.'
              : 'Opcional. Añade un código de un solo uso además de tu contraseña.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {enabled === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : enabled ? (
            <Button
              variant="outline"
              data-testid="mfa-disable"
              onClick={() => setConfirming(true)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Desactivar
            </Button>
          ) : (
            <Link href="/mfa?next=%2Fsettings%3Ftab%3Dsecurity">
              <Button
                data-testid="mfa-enable"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Activar
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="border-border bg-card">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              ¿Desactivar la verificación en dos pasos?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Tu cuenta volverá a estar protegida solo por la contraseña. Puedes
              volver a activarla cuando quieras.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={working}
              className="border-border text-muted-foreground"
            >
              Cancelar
            </Button>
            <Button onClick={disable} disabled={working}>
              {working ? 'Desactivando…' : 'Desactivar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
