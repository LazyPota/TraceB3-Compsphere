'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useConnection, useDisconnect, useSignMessage } from 'wagmi';
import {
  api,
  ApiProblemError,
  setUnauthorizedHandler,
  type MemberProfile,
} from './api';

export interface StoredAuthSession {
  token: string;
  expiresAt: string;
  member: MemberProfile;
}

const SESSION_KEY = 'traceb3_auth_session_v1';
const listeners = new Set<() => void>();
let cachedRawSession: string | null = null;
let cachedParsedSession: StoredAuthSession | null = null;

function notifySessionChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readStoredSession(): StoredAuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw === cachedRawSession) {
      return cachedParsedSession;
    }
    cachedRawSession = raw;
    if (!raw) {
      cachedParsedSession = null;
      return null;
    }
    const parsed = JSON.parse(raw) as StoredAuthSession;
    if (
      !parsed?.token ||
      !parsed?.member?.walletAddress ||
      (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now())
    ) {
      window.sessionStorage.removeItem(SESSION_KEY);
      cachedRawSession = null;
      cachedParsedSession = null;
      return null;
    }
    cachedParsedSession = parsed;
    return parsed;
  } catch {
    cachedRawSession = null;
    cachedParsedSession = null;
    return null;
  }
}

function writeStoredSession(session: StoredAuthSession | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (session) {
      const encoded = JSON.stringify(session);
      window.sessionStorage.setItem(SESSION_KEY, encoded);
      cachedRawSession = encoded;
      cachedParsedSession = session;
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
      cachedRawSession = null;
      cachedParsedSession = null;
    }
  } catch {
    cachedParsedSession = session;
  }
  notifySessionChange();
}

function subscribeSession(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

interface AuthContextValue {
  token: string | null;
  member: MemberProfile | null;
  expiresAt: string | null;
  isAuthenticated: boolean;
  isSigningIn: boolean;
  authError: string | null;
  signInWithSiwe: () => Promise<MemberProfile>;
  signOut: (disconnectWallet?: boolean) => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(
    subscribeSession,
    readStoredSession,
    () => null,
  );
  const { address, isConnected, status: connectionStatus } = useConnection();
  const { mutate: disconnectWallet } = useDisconnect();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const signOut = useCallback(
    (alsoDisconnect = false) => {
      writeStoredSession(null);
      setAuthError(null);
      if (alsoDisconnect) {
        disconnectWallet();
      }
    },
    [disconnectWallet],
  );

  // Register global 401 handler so stale tokens auto-clear cleanly.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      writeStoredSession(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Invalidate stored JWT if wallet switches accounts or disconnects after hydration settles.
  useEffect(() => {
    if (!session) return;
    if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
      return;
    }
    if (
      !isConnected ||
      !address ||
      address.toLowerCase() !== session.member.walletAddress.toLowerCase()
    ) {
      writeStoredSession(null);
    }
  }, [session, address, isConnected, connectionStatus]);

  const signInWithSiwe = useCallback(async (): Promise<MemberProfile> => {
    if (!address) {
      throw new Error('Connect an EVM wallet before signing in.');
    }
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const { nonce, domain, chainId } = await api.getNonce();
      const message = createSiweMessage({
        address,
        chainId,
        domain,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to TRACEB3 Digital Waste Passport',
      });
      const signature = await signMessageAsync({ message });
      const verified = await api.verifySiwe(message, signature);
      writeStoredSession({
        token: verified.token,
        expiresAt: verified.expiresAt,
        member: verified.member,
      });
      return verified.member;
    } catch (err) {
      const msg =
        err instanceof ApiProblemError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : 'SIWE authentication failed.';
      setAuthError(msg);
      throw err;
    } finally {
      setIsSigningIn(false);
    }
  }, [address, signMessageAsync]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: session?.token ?? null,
      member: session?.member ?? null,
      expiresAt: session?.expiresAt ?? null,
      isAuthenticated: Boolean(session?.token && session?.member),
      isSigningIn,
      authError,
      signInWithSiwe,
      signOut,
      clearError: () => setAuthError(null),
    }),
    [session, isSigningIn, authError, signInWithSiwe, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
