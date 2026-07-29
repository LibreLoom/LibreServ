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
      const acct = { id: res.id, email: res.email, name: res.name, has_2fa: res.has_2fa };
      setAccount(acct);
      localStorage.setItem("connect-admin-account", JSON.stringify(acct));
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const seedAdmin = useCallback(async (email, password, name) => {
    return api.seedAdmin(email, password, name);
  }, []);

  // Restore account info from token on mount/refresh.
  // The login response includes has_2fa, but that snapshot is lost on
  // page refresh. Re-derive by listing admins and matching our token's
  // account — or simply re-login isn't viable (no stored password).
  // Instead, we fetch /admin/admins (which returns has_2fa per account)
  // and match by email stored in a lightweight localStorage cache.
  const ACCOUNT_CACHE_KEY = "connect-admin-account";
  useEffect(() => {
    if (!getToken()) return;
    const cached = (() => {
      try { return JSON.parse(localStorage.getItem(ACCOUNT_CACHE_KEY) || "null"); }
      catch { return null; }
    })();
    if (cached) {
      setAccount(cached);
      // Refresh has_2fa from server in background
      api.listAdmins().then((data) => {
        const found = (data?.admins || []).find((a) => a.email === cached.email);
        if (found && found.has_2fa !== cached.has_2fa) {
          const updated = { ...cached, has_2fa: found.has_2fa };
          setAccount(updated);
          localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(updated));
        }
      }).catch(() => {});
    }
  }, []);

  const updateAccount = useCallback((updater) => {
    setAccount((prev) => {
      const next = typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setAccount(null);
    localStorage.removeItem(ACCOUNT_CACHE_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, account, login, seedAdmin, logout, updateAccount, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
