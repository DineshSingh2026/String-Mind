'use client';
/**
 * Current user/org context for the app. Backed by GET /auth/me:
 *   { user: { id, email, name, platformRole, persona, mfaEnabled }, org: { id, name, slug, type, plan } | null,
 *     role: OrgRole | null, permissions: Permission[], orgs: { id, name, slug, type, role }[],
 *     welcomeBonus: { granted, amount, grantedAt } }
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useApi, setActiveOrg } from './api';
import type { OrgRole, Permission } from '@aix/shared';

export interface Me {
  user: { id: string; email: string; name: string; platformRole: 'user' | 'admin' | 'super_admin'; persona: string; mfaEnabled: boolean };
  org: { id: string; name: string; slug: string; type: string; plan: string } | null;
  role: OrgRole | null;
  permissions: Permission[];
  orgs: { id: string; name: string; slug: string; type: string; role: OrgRole }[];
  /** One-time 1,000 IDLE welcome bonus status (see docs/IDLE_TOKENS.md). Optional for older API builds. */
  welcomeBonus?: { granted: boolean; amount: number; grantedAt: string | null } | null;
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => void; can: (p: Permission) => boolean; unavailable: boolean }>({
  me: null, loading: true, refresh: () => undefined, can: () => false, unavailable: false,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, mutate, error } = useApi<Me>('/auth/me', { shouldRetryOnError: false });
  // Only a 401 means "signed out". Network/5xx errors mean the API is temporarily unavailable —
  // keep the last known session instead of bouncing the user to sign-in.
  const signedOut = error?.status === 401 || error?.status === 403;
  const me = signedOut ? null : data ?? null;
  const unavailable = !!error && !signedOut && !data;
  return (
    <Ctx.Provider value={{ me, loading: isLoading, refresh: () => void mutate(), can: (p) => !!me?.permissions.includes(p), unavailable }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSession = () => useContext(Ctx);

export function switchOrg(id: string) {
  setActiveOrg(id);
  window.location.reload();
}
