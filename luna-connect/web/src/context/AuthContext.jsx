import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "../api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const account = await api("/api/v1/account/me");
      setMe(account);
      return account;
    } catch {
      setMe(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    await api("/api/v1/account/login", { method: "POST", body: JSON.stringify({ email, password }) });
    return refresh();
  }, [refresh]);

  const register = useCallback(async (email, password) => {
    await api("/api/v1/account/register", { method: "POST", body: JSON.stringify({ email, password }) });
    return refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api("/api/v1/account/logout", { method: "POST", body: "{}" });
    } catch {
      /* cookie may already be gone */
    }
    setMe(null);
  }, []);

  const markEmailVerified = useCallback(() => {
    setMe((a) => (a ? { ...a, email_verified: true } : a));
  }, []);

  const updateAccountEmail = useCallback(async (email, source = "") => {
    const res = await api("/api/v1/account/email", {
      method: "POST",
      body: JSON.stringify({ email, source }),
    });
    setMe((a) => (a ? { ...a, email: res.email || email, email_verified: false } : a));
    return res;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        me,
        ready,
        isAuthenticated: Boolean(me),
        refresh,
        login,
        register,
        logout,
        markEmailVerified,
        updateAccountEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
