'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Copy, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface MetaAppState {
  configured: boolean;
  meta_app_id?: string | null;
  webhook_token?: string | null;
  has_app_secret?: boolean;
}

/**
 * Owner-only: an account's own Meta app (App ID + App Secret), so a
 * client who owns their Business Manager can connect through their
 * own app instead of the deployment-wide one behind META_APP_ID /
 * META_APP_SECRET. Rendered by whatsapp-config.tsx inside
 * `<RequireRole min="owner">` — this component assumes that gate has
 * already passed and fetches unconditionally on mount.
 *
 * See src/app/api/whatsapp/meta-app/route.ts for the endpoint this
 * talks to — GET never returns the secret itself, only whether one is
 * set, so this component never has the plaintext or ciphertext to
 * leak in the first place.
 */
export function MetaAppSettings() {
  const t = useTranslations('Settings.whatsapp.metaApp');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [state, setState] = useState<MetaAppState | null>(null);

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [secretEdited, setSecretEdited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/whatsapp/meta-app');
        const data = (await res.json()) as MetaAppState;
        if (cancelled) return;
        setState(data);
        setAppId(data.meta_app_id ?? '');
        setAppSecret('');
        setSecretEdited(false);
      } catch (err) {
        console.error('Failed to load Meta app settings:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const webhookUrl =
    typeof window !== 'undefined' && state?.webhook_token
      ? `${window.location.origin}/api/whatsapp/webhook/${state.webhook_token}`
      : '';

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  async function handleSave() {
    const payload: Record<string, unknown> = {
      meta_app_id: appId.trim() || null,
    };
    if (secretEdited) {
      payload.meta_app_secret = appSecret.trim() || null;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/meta-app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save Meta app settings');
        return;
      }
      setState(data);
      setAppId(data.meta_app_id ?? '');
      setAppSecret('');
      setSecretEdited(false);
      toast.success(t('savedToast'));
    } catch (err) {
      console.error('Save Meta app error:', err);
      toast.error('Failed to save Meta app settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!confirm(t('clearConfirm'))) return;

    setClearing(true);
    try {
      const res = await fetch('/api/whatsapp/meta-app', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to reset Meta app settings');
        return;
      }
      setState(data);
      setAppId('');
      setAppSecret('');
      setSecretEdited(false);
      toast.success(t('clearedToast'));
    } catch (err) {
      console.error('Clear Meta app error:', err);
      toast.error('Failed to reset Meta app settings');
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!state?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('needsWhatsAppFirst')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-muted-foreground">{t('appId')}</Label>
          <Input
            placeholder={t('appIdPlaceholder')}
            value={appId}
            onChange={(e) => setAppId(e.target.value.replace(/\D/g, ''))}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">{t('appIdHint')}</p>
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">{t('appSecret')}</Label>
          <div className="relative">
            <Input
              type={showSecret ? 'text' : 'password'}
              placeholder={
                state.has_app_secret ? t('appSecretPlaceholderSet') : t('appSecretPlaceholderUnset')
              }
              value={appSecret}
              onChange={(e) => {
                setAppSecret(e.target.value);
                setSecretEdited(true);
              }}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
            />
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t('appSecretHint')}</p>
        </div>

        {state.webhook_token && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={webhookUrl}
                className="bg-muted border-border text-muted-foreground font-mono text-sm"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopyWebhookUrl}
                className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('webhookUrlHint')}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
          {(state.meta_app_id || state.has_app_secret) && (
            <Button
              variant="outline"
              onClick={handleClear}
              disabled={clearing}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {clearing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('clearing')}
                </>
              ) : (
                t('clear')
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
