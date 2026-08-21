/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getJson, postJson } from "../lib/api";

const AuthContext = createContext(undefined);

// Pages you may visit before Luna is set up. Everything else bounces to the
// setup wizard (same behavior as LibreServ's AuthContext), so a fresh Luna
// always boots straight into setup instead of an app with no account.
const ALLOWED_DURING_SETUP = ["/setup", "/login"];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  // Keep the latest navigate in a ref so the startup effect below can stay
  // stable. In a BrowserRouter, useNavigate() returns a NEW function whenever
  // the route changes (it closes over the current pathname), so putting it in
  // the effect's deps made the effect — and its refresh() — re-run on every
  // navigation, clobbering the just-logged-in user with a stale /auth/me read.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  // Re-fetch the signed-in user and the setup state. Called at startup and
  // after big state changes (creating the admin account, finishing setup) so
  // the routes guarded by RequireAuth see the fresh state instead of the
  // snapshot from page load.
  //
  // A /auth/me that FAILS (network blip, 5xx) is treated as "unknown" and the
  // current user is kept, so a transient error can't silently log someone out.
  // Only a clean 200 with a null body (not signed in) clears the user.
  const refresh = useCallback(async () => {
    let me = null;
    let meFailed = false;
    try {
      me = await getJson("/api/v1/auth/me");
    } catch {
      meFailed = true;
    }
    const setupState = await getJson("/api/v1/setup").catch(() => null);
    if (!meFailed) setUser(me || null);
    if (setupState) setSetup(setupState);
    return { me: me || null, setup: setupState };
  }, []);

  // Startup-only: restore the session (or send a fresh Luna to the wizard)
  // exactly once. Deps are stable (refresh never changes), so this runs a
  // single time on mount — NOT on every route change.
  useEffect(() => {
    let alive = true;
    const path = location.pathname;
    (async () => {
      const { setup: setupState } = await refresh();
      if (!alive) return;
      const needsSetup = Boolean(setupState && setupState.setup_completed === false);
      if (needsSetup && !ALLOWED_DURING_SETUP.includes(path)) {
        navigateRef.current("/setup", { replace: true });
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- location.pathname intentionally omitted: the setup check runs once at startup
  }, [refresh]);

  const login = useCallback(async (username, password) => {
    // Cookie session only — login JSON has no JWT. fetch uses credentials: include.
    const me = await postJson("/api/v1/auth/login", { username, password });
    setUser(me);
    return me;
  }, []);

  const register = useCallback(async (username, displayName, password) => {
    const created = await postJson("/api/v1/auth/register", {
      username,
      display_name: displayName,
      password,
    });
    return created;
  }, []);

  const logout = useCallback(async () => {
    try { await postJson("/api/v1/auth/logout", {}); } catch { /* session already gone */ }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, setup, loading, login, register, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
