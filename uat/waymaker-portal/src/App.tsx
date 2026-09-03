import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { ENV_LABEL, supabase } from './lib/supabase';
import type { Profile } from './lib/types';
import Login from './routes/Login';
import Queue from './routes/Queue';
import RequestDetail from './routes/RequestDetail';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  /* Three states, not two. Until the first getSession() settles we do not know
     whether this person is signed in, and rendering Login in the meantime
     flashes a password form at someone who already has a session. */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setSession(data.session);
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });

    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  /* The profile decides what the queue may show. It is created by a trigger on
     signup, so a session without one means the trigger did not run — worth
     saying out loud rather than rendering an empty queue that looks like "no
     requests yet". */
  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    supabase
      .from('profiles')
      .select('id, display_name, role, artist_key')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setProfile((data as Profile) ?? null));
  }, [session]);

  if (!ready) return <div className="wm-boot">Loading…</div>;
  if (!session) return <Login />;

  return (
    <div className="wm-app">
      {ENV_LABEL && <div className="wm-env-flag">{ENV_LABEL}</div>}
      <Chrome profile={profile} email={session.user.email ?? ''} />
      <main className="wm-main">
        {profile === null ? (
          <p className="wm-empty">
            This account has no profile row, so it can't see any requests. Add one in
            the Supabase dashboard: <code>profiles</code> → set <code>role</code> and{' '}
            <code>artist_key</code>.
          </p>
        ) : (
          <Routes>
            <Route path="/" element={<Queue profile={profile} />} />
            <Route path="/r/:rid" element={<RequestDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function Chrome({ profile, email }: { profile: Profile | null; email: string }) {
  const { pathname } = useLocation();

  return (
    <header className="wm-chrome">
      <Link to="/" className="wm-chrome-brand">
        <img src="/WaymakerInk_Logo_transparent.png" alt="" width={44} height={44} />
        <span>Requests</span>
      </Link>

      {pathname !== '/' && (
        <Link to="/" className="wm-chrome-back">
          ← All requests
        </Link>
      )}

      <div className="wm-chrome-user">
        <span title={email}>{profile?.display_name || email}</span>
        <button type="button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
