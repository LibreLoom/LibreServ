import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api, getToken, setToken, clearToken } from "../api/client.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(!!getToken());
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (email, password, totpCode) => {
    setLoading(true);
    try {
      const res = await api.login(email, password, totpCode);
      if (res.requires_2fa) {
        return res;
      }
      setToken(res.token);
      setIsAuthenticated(true);
      setAccount({
        id: res.id, email: res.email, name: res.name,
        plan_id: res.plan_id, has_2fa: res.has_2fa,
        email_verified: res.email_verified,
      });
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (email, password, name, username) => {
    setLoading(true);
    try {
      const res = await api.register(email, password, name, username);
      // Register now returns a token — auto sign-in
      if (res.token) {
        setToken(res.token);
        setIsAuthenticated(true);
        setAccount({
          id: res.id, email: res.email, name: res.name,
          username: res.username, plan_id: res.plan_id,
          has_2fa: res.has_2fa, email_verified: res.email_verified,
        });
      }
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setAccount(null);
  }, []);

  useEffect(() => {
    if (isAuthenticated && !account) {
      // Account info is set during login; no separate fetch needed
    }
  }, [isAuthenticated, account]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, account, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
