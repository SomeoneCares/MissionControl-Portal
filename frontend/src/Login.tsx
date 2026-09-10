import { useState } from "react";
import { api } from "./api/client";
import { settings } from "./store/settings";

// The sign-in gate. Shown when the backend reports auth is required and this browser has no
// valid session cookie yet. A fresh install ships with username "admin" / password "admin";
// the user changes both in Settings. On success the backend sets a 30-day session cookie.
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = settings.get().portalName || "Hermes";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onAuthed();
    } catch {
      setError("Incorrect username or password.");
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="dot" />
          <span className="display brand-name">{brand}</span>
          <span className="mono brand-sub">Mission Control</span>
        </div>
        <p className="login-hint">Sign in to reach this portal.</p>
        <label className="login-label">Username</label>
        <input
          className="login-input"
          type="text"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label className="login-label">Password</label>
        <input
          className="login-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="login-btn" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-foot mono">Default credentials: admin / admin — change them in Settings.</p>
      </form>
    </div>
  );
}
