import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import type { BusinessSettings, StaffSession } from '../api/types';
import { protectedData } from './protected-data';

const signOutMarker = 'food-reservations:signout-pending';
type SessionStatus = 'checking' | 'anonymous' | 'authenticated' | 'error';

function validSession(value: StaffSession): StaffSession {
  if (!value?.user?.id || !value.user.display_name || !value.csrf_token
    || !Number.isFinite(Date.parse(value.idle_expires_at)) || !Number.isFinite(Date.parse(value.absolute_expires_at))) {
    throw new ApiError(200, 'invalid_response', 'The server returned an invalid staff session.');
  }
  return value;
}

function validSettings(value: BusinessSettings): BusinessSettings {
  if (!value || !/^[A-Z]{3}$/.test(value.currency) || !Number.isInteger(value.minor_digits)
    || value.minor_digits < 0 || value.minor_digits > 9 || typeof value.timezone !== 'string' || !value.timezone || !value.confirmation
    || !Array.isArray(value.fulfillment_methods) || !value.capabilities) {
    throw new ApiError(200, 'invalid_response', 'Business settings are incomplete.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format(); }
  catch { throw new ApiError(200, 'invalid_response', 'The business timezone is invalid.'); }
  return value;
}

function useSessionState(client: ApiClient) {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [session, setSession] = useState<StaffSession | null>(null);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [reason, setReason] = useState<'expired' | 'signed-out' | null>(null);
  const [signOutPending, setSignOutPending] = useState(() => sessionStorage.getItem(signOutMarker) === '1');
  const [signOutBusy, setSignOutBusy] = useState(false);
  const epoch = useRef(0);
  const activeSession = useRef<StaffSession | null>(null);

  const clearSession = useCallback((nextReason: 'expired' | 'signed-out' | null) => {
    epoch.current++;
    activeSession.current = null;
    client.clearCredentials();
    protectedData.clear();
    setSession(null); setSettings(null); setSettingsError(null); setSessionError(null);
    setReason(nextReason); setStatus('anonymous');
  }, [client]);

  const loadSettings = useCallback(async () => {
    const requestEpoch = epoch.current;
    setSettingsError(null);
    try {
      const result = validSettings(await client.request<BusinessSettings>('/settings'));
      // Responses from a prior session must never restore protected state.
      if (requestEpoch === epoch.current && activeSession.current) setSettings(result);
    } catch (error) {
      if (requestEpoch === epoch.current && activeSession.current) setSettingsError((error as Error).message);
    }
  }, [client]);

  const checkSession = useCallback(async (atExpiry = false) => {
    if (sessionStorage.getItem(signOutMarker) === '1') { setStatus('anonymous'); setSignOutPending(true); return; }
    const requestEpoch = epoch.current;
    if (!activeSession.current) setStatus('checking');
    setSessionError(null);
    try {
      const result = validSession(await client.request<StaffSession>('/auth/session'));
      if (requestEpoch !== epoch.current) return;
      if (Math.min(Date.parse(result.idle_expires_at), Date.parse(result.absolute_expires_at)) <= client.now()) {
        clearSession('expired'); return;
      }
      const initial = !activeSession.current;
      activeSession.current = result;
      client.setCsrfToken(result.csrf_token);
      setSession(result); setStatus('authenticated');
      if (initial) void loadSettings();
    } catch (error) {
      if (requestEpoch !== epoch.current) return;
      if (error instanceof ApiError && error.status === 401) {
        clearSession(error.code === 'session_expired' ? 'expired' : null);
      } else if (atExpiry) clearSession('expired');
      else { setSessionError((error as Error).message); if (!activeSession.current) setStatus('error'); }
    }
  }, [client, clearSession, loadSettings]);

  useEffect(() => {
    const unsubscribe = client.onSessionExpired(() => { if (activeSession.current) clearSession('expired'); });
    void checkSession();
    return () => { unsubscribe(); epoch.current++; client.clearCredentials(); protectedData.clear(); };
  }, [client, checkSession, clearSession]);

  useEffect(() => {
    if (!session) return;
    const expiresAt = Math.min(Date.parse(session.idle_expires_at), Date.parse(session.absolute_expires_at));
    const expiryTimer = setTimeout(() => { void checkSession(true); }, Math.max(0, expiresAt - client.now()));
    const poll = setInterval(() => { void checkSession(); }, 60000);
    const onFocus = () => { void checkSession(); };
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(expiryTimer); clearInterval(poll); window.removeEventListener('focus', onFocus); };
  }, [client, session, checkSession]);

  async function signIn(username: string, token: string) {
    const requestEpoch = epoch.current;
    const result = validSession(await client.request<StaffSession>('/auth/sign-in', {
      method: 'POST', body: { username, token },
    }));
    if (requestEpoch !== epoch.current) return;
    client.setCsrfToken(result.csrf_token);
    activeSession.current = result; setSession(result); setReason(null); setStatus('authenticated');
    void loadSettings();
  }

  async function signOut() {
    if (signOutBusy) return;
    sessionStorage.setItem(signOutMarker, '1');
    setSignOutPending(true); setSignOutBusy(true);
    clearSession('signed-out');
    try {
      await client.request('/auth/sign-out', { method: 'POST', body: {} });
      client.clearCredentials(); sessionStorage.removeItem(signOutMarker); setSignOutPending(false);
    } catch { setSessionError('Server sign-out is unconfirmed. Retry before signing in again.'); }
    finally { setSignOutBusy(false); }
  }

  return { status, session, settings, settingsError, sessionError, reason, signOutPending, signOutBusy,
    signIn, signOut, checkSession, loadSettings };
}

const SessionContext = createContext<ReturnType<typeof useSessionState> | null>(null);
export function SessionProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const value = useSessionState(client);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('Staff session context is missing.');
  return context;
}
