import { useState, type FormEvent } from 'react';
import { ENV_LABEL, supabase } from '../lib/supabase';

/* Email and password. No signup link and no magic link, deliberately:
   `enable_signup = false` in supabase/config.toml means the form would fail
   anyway, and a password reset that mails a link to an address anyone can type
   is a way into a portal holding every client's phone number. Accounts are
   created by hand in the dashboard. */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');

    const { error: err } = await supabase.auth.signInWithPassword({ email, password });

    if (err) {
      /* Supabase says "Invalid login credentials" for both a wrong password
         and an address that does not exist, and that is the right answer to
         keep — distinguishing them tells anyone probing which addresses are
         real. Passed through rather than rewritten so a genuinely different
         failure (rate limit, network) still reads as itself. */
      setError(err.message);
      setBusy(false);
      return;
    }
    /* No navigate: onAuthStateChange in App swaps the tree. */
  }

  return (
    <div className="wm-login">
      {ENV_LABEL && <div className="wm-env-flag">{ENV_LABEL}</div>}

      <form className="wm-login-card" onSubmit={onSubmit}>
        <img src="/WaymakerInk_Logo_transparent.png" alt="WayMaker Ink" width={64} height={64} />
        <p className="wm-kicker">Appointment Requests</p>
        <h1>Sign in</h1>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="wm-login-error" role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
