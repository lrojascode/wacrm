'use client';

// ============================================================
// AddMemberDialog
//
// Two-step modal, same shape as InviteMemberDialog:
//   1. Form   — name + email + password + role → POST creates the
//              login directly (pre-confirmed, no invite link).
//   2. Result — recap of the credentials so the owner can copy/share
//              them. We never persist the plaintext password past
//              this request, so once the dialog closes it's gone —
//              same "save it now" contract as the invite link.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, Loader2, MessageCircle, Sparkles, RefreshCw } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { ASSIGNABLE_ROLES } from '@/lib/auth/roles';

type MemberRole = 'admin' | 'agent';

const MIN_PASSWORD_LEN = 8;
const MAX_NAME_LEN = 80;

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the roster. */
  onCreated: () => void;
}

interface CreatedMember {
  email: string;
  password: string;
  role: MemberRole;
  accountName: string;
}

// crypto.getRandomValues rather than Math.random — this ends up in a
// real login credential, not a UI placeholder.
function generatePassword(): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function AddMemberDialog({ open, onOpenChange, onCreated }: AddMemberDialogProps) {
  const t = useTranslations('Settings.addMember');
  const tRoles = useTranslations('Settings.roles');
  const { account } = useAuth();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<MemberRole>('agent');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreatedMember | null>(null);

  function reset() {
    setFullName('');
    setEmail('');
    setPassword('');
    setShowPassword(false);
    setRole('agent');
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmedName = fullName.trim();
    if (trimmedName.length > MAX_NAME_LEN) {
      toast.error(t('nameTooLong', { max: MAX_NAME_LEN }));
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      toast.error(t('passwordTooShort', { min: MIN_PASSWORD_LEN }));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          fullName: trimmedName || undefined,
          role,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to create member');
        return;
      }

      setResult({
        email: email.trim(),
        password,
        role,
        accountName: account?.name ?? 'our wacrm account',
      });
      onCreated();
    } catch (err) {
      console.error('[AddMemberDialog] create error:', err);
      toast.error('Could not reach the server. Try again?');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCredentials() {
    if (!result) return;
    const text = t('credentialsText', { email: result.email, password: result.password });
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('clipboardBlocked'));
    }
  }

  function whatsappShareUrl(): string {
    if (!result) return '#';
    const message = t('whatsappMessage', {
      accountName: result.accountName,
      email: result.email,
      password: result.password,
    });
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Sparkles className="size-4 text-primary" />
                {t('memberCreated')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('memberCreatedDesc', {
                  role: tRoles(result.role),
                  bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('emailLabel')}</Label>
                <Input
                  readOnly
                  value={result.email}
                  className="bg-muted border-border text-foreground font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('passwordLabel')}</Label>
                <Input
                  readOnly
                  value={result.password}
                  className="bg-muted border-border text-foreground font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>

              <Button
                type="button"
                onClick={copyCredentials}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Copy className="size-4" />
                {t('copyCredentials')}
              </Button>

              <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
                <strong className="font-semibold text-amber-100">
                  {t('saveNow')}
                </strong>{' '}
                {t('saveNowHint')}
              </div>

              <a
                href={whatsappShareUrl()}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({
                  variant: 'outline',
                  className: 'w-full border-border text-muted-foreground hover:bg-muted',
                })}
              >
                <MessageCircle className="size-4" />
                {t('sendViaWhatsApp')}
              </a>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('dialogTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('dialogDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('nameLabel')}{' '}
                  <span className="text-xs text-muted-foreground">{t('optional')}</span>
                </Label>
                <Input
                  placeholder={t('namePlaceholder')}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  maxLength={MAX_NAME_LEN}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('emailLabel')}</Label>
                <Input
                  type="email"
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('passwordLabel')}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      placeholder={t('passwordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPassword(generatePassword());
                      setShowPassword(true);
                    }}
                    className="border-border text-muted-foreground hover:bg-muted shrink-0"
                  >
                    <RefreshCw className="size-4" />
                    {t('generate')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('passwordHint', { min: MIN_PASSWORD_LEN })}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('roleLabel')}</Label>
                <Select value={role} onValueChange={(v) => v && setRole(v as MemberRole)}>
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {tRoles(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {tRoles(`${role}Hint` as 'adminHint' | 'agentHint')}
                </p>
              </div>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting || !email.trim() || password.length < MIN_PASSWORD_LEN}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('createMember')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
