import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, LogIn, RotateCw, Utensils } from 'lucide-react';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import { Feedback, Field, IconButton, Loading } from '../components/ui';

function safeReturn(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  const pathname = new URL(value, 'http://local').pathname;
  return ['/', '/account', '/menu', '/orders', '/dashboard', '/ingredients', '/purchases'].includes(pathname) || /^\/orders\/[^/]+(?:\/print)?$/.test(pathname) || /^\/(ingredients|purchases)\/[^/]+$/.test(pathname) || /^\/menu\/[^/]+\/variants\/[^/]+\/recipe$/.test(pathname) ? value : '/';
}

export function SignIn({ mode }: { mode: 'live' | 'fixtures' }) {
  const auth = useSession();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('admin');
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [connectionError, setConnectionError] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (busy) return;
    if (fields.username) usernameRef.current?.focus();
    else if (fields.token) tokenRef.current?.focus();
  }, [busy, fields]);
  if (auth.status === 'authenticated') return <Navigate to={safeReturn(params.get('returnTo'))} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || auth.signOutPending || auth.status !== 'anonymous') return;
    const invalid: Record<string, string> = {};
    if (!username.trim()) invalid.username = 'Enter your username.';
    if (!token.trim()) invalid.token = 'Enter your token.';
    setFields(invalid); setError(null); setConnectionError(false);
    if (Object.keys(invalid).length) {
      (invalid.username ? usernameRef : tokenRef).current?.focus(); return;
    }
    setBusy(true);
    try { await auth.signIn(username.trim(), token); }
    catch (failure) {
      const apiError = failure as ApiError;
      setError(apiError.message);
      setConnectionError(apiError.code === 'connection_error' || apiError.status >= 500);
      const fieldErrors: Record<string, string> = {};
      apiError.fieldErrors?.forEach(field => {
        if (field.path === '/username' || field.path === '/token') fieldErrors[field.path.slice(1)] = field.message;
      });
      setFields(fieldErrors);
    } finally { setBusy(false); }
  }

  return <main className="signin-page">
    <div className="signin-top"><a href="/" className="brand"><Utensils size={22} aria-hidden="true" /><span>Food reservations</span></a>
      <span className="environment-label">{mode === 'fixtures' ? 'Development fixtures' : 'Staff access'}</span>
    </div>
    <div className="signin-content">
      <img className="food-strip" src="/food.jpg" alt="A prepared vegetable dish" />
      <div className="signin-heading"><span className="eyebrow">STAFF ACCESS</span><h1>Sign in</h1></div>
      {auth.reason === 'expired' && <Feedback>Your session expired. Sign in to continue.</Feedback>}
      {auth.reason === 'signed-out' && !auth.signOutPending && <Feedback>Signed out.</Feedback>}
      {auth.status === 'checking' && <Loading>Checking your session...</Loading>}
      {auth.sessionError && <Feedback error>{auth.sessionError}</Feedback>}
      {auth.status === 'error' && <button className="button secondary" onClick={() => void auth.checkSession()}><RotateCw size={17} />Retry session check</button>}
      {auth.signOutPending && <div className="signout-recovery">
        {!auth.sessionError && <Feedback>Confirming server sign-out...</Feedback>}
        <button className="button secondary" disabled={auth.signOutBusy} onClick={() => void auth.signOut()}><RotateCw size={17} />Retry sign-out</button>
      </div>}
      <form onSubmit={submit} noValidate aria-busy={busy}>
        <Field id="username" ref={usernameRef} label="Username" autoComplete="username" value={username}
          onChange={event => setUsername(event.target.value)} error={fields.username} disabled={busy || auth.signOutPending} />
        <Field id="token" ref={tokenRef} label="Token" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false}
          value={token} onChange={event => setToken(event.target.value)} error={fields.token} disabled={busy || auth.signOutPending}
          suffix={<IconButton label={visible ? 'Hide token' : 'Show token'} onClick={() => setVisible(!visible)} disabled={busy || auth.signOutPending}>
            {visible ? <EyeOff size={19} /> : <Eye size={19} />}</IconButton>} />
        {error && <Feedback error>{error}</Feedback>}
        <button className="button primary signin-submit" type="submit" disabled={busy || auth.status !== 'anonymous' || auth.signOutPending}>
          {connectionError ? <RotateCw size={18} /> : <LogIn size={18} />}
          {busy ? 'Signing in...' : connectionError ? 'Retry sign-in' : 'Sign in'}
        </button>
      </form>
      <div className="signin-foot"><span>Staff accounts only</span><span>Food reservations</span></div>
    </div>
  </main>;
}
