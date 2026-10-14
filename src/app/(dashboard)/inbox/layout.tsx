'use client';

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { InboxWorkspace } from '@/components/inbox/inbox-workspace';

export default function InboxLayout({ children }: { children: ReactNode }) {
  const { user, accountId, loading } = useAuth();
  const resolvedScope = user && accountId ? `${user.id}:${accountId}` : null;
  const [scope, setScope] = useState<string | null>(resolvedScope);
  // A transient profile/session refresh must not discard the workspace.
  // A confirmed account change/sign-out must discard its private cache.
  if (resolvedScope && resolvedScope !== scope) setScope(resolvedScope);
  if (!user && !loading && scope) setScope(null);
  return (
    <>
      {scope ? (
        <InboxWorkspace key={scope} />
      ) : (
        <div className="bg-background h-full" aria-busy="true" />
      )}
      {children}
    </>
  );
}
