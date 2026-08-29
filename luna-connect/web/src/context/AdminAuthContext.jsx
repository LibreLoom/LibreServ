import { createContext, useCallback, useContext, useEffect, useState } from "react";

const TOKEN_KEY = "luna-connect-admin-token";
const ACCOUNT_KEY = "luna-connect-admin-account";

const AdminAuthContext = createContext(null);

export function getAdminToken() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setAdminToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCOUNT_KEY);
}

export async function adminApi(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== "GET" && method !== "HEAD" && !headers.Authorization) {
    // CSRF cookie path for seed/login without bearer
    const match = typeof document !== "undefined" ? document.cookie.match(/(?:^|; )luna_connect_csrf=([^;]*)/) : null;
    if (match) headers["X-CSRF-Token"] = decodeURIComponent(match[1]);
  } else if (method !== "GET" && method !== "HEAD") {
    const match = typeof document !== "undefined" ? document.cookie.match(/(?:^|; )luna_connect_csrf=([^;]*)/) : null;
    if (match) headers["X-CSRF-Token"] = decodeURIComponent(match[1]);
  }
  const res = await fetch(path, { ...opts, credentials: "include", headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || "That didn't work. Try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}

export function AdminAuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      setReady(true);
      return;
    }
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null");
    } catch {
      cached = null;
    }
    if (cached) setAccount(cached);
    setIsAuthenticated(true);
    adminApi("/admin/me")
      .then((me) => {
        const next = { id: me.id, email: me.email, name: me.name, has_2fa: me.has_2fa };
        setAccount(next);
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
      })
      .catch(() => {
        clearAdminToken();
        setIsAuthenticated(false);
        setAccount(null);
      })
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email, password, totpCode) => {
    setLoading(true);
    try {
      const res = await adminApi("/admin/login", {
        method: "POST",
        body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
      });
      if (res.requires_2fa) return res;
      setAdminToken(res.token);
      const acct = { id: res.id, email: res.email, name: res.name, has_2fa: res.has_2fa };
      setAccount(acct);
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acct));
      setIsAuthenticated(true);
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const seedAdmin = useCallback(async (email, password, name) => {
    return adminApi("/admin/seed", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await adminApi("/admin/logout", { method: "POST", body: "{}" });
    } catch {
      /* ignore */
    }
    clearAdminToken();
    setIsAuthenticated(false);
    setAccount(null);
  }, []);

  const updateAccount = useCallback((updater) => {
    setAccount((prev) => {
      const next = typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <AdminAuthContext.Provider value={{ ready, isAuthenticated, account, loading, login, seedAdmin, logout, updateAccount }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
