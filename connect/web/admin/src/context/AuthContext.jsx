import { createContext, useContext, useState, useCallback } from "react";
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
      setAccount({ id: res.id, email: res.email, name: res.name, has_2fa: res.has_2fa });
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const seedAdmin = useCallback(async (email, password, name) => {
    return api.seedAdmin(email, password, name);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setAccount(null);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, account, login, seedAdmin, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
