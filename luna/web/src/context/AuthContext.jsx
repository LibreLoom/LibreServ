/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getJson, postJson } from "../lib/api";

const AuthContext = createContext(undefined);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getJson("/api/v1/auth/me")
      .then((me) => { if (alive) setUser(me); })
      .catch(() => { if (alive) setUser(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

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
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
