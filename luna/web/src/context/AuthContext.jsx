/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
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

  useEffect(() => {
    let alive = true;
    const path = location.pathname;
    Promise.all([
      getJson("/api/v1/auth/me").catch(() => null),
      getJson("/api/v1/setup").catch(() => null),
    ]).then(([me, setupState]) => {
      if (!alive) return;
      setUser(me || null);
      setSetup(setupState);
      const needsSetup = Boolean(setupState && setupState.setup_completed === false);
      if (needsSetup && !ALLOWED_DURING_SETUP.includes(path)) {
        navigate("/setup", { replace: true });
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- location.pathname intentionally omitted: the setup check runs once at startup
  }, [navigate]);

  const login = useCallback(async (username, password) => {
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
    <AuthContext.Provider value={{ user, setup, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
