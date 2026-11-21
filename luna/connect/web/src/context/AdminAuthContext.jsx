import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { fetchOrExplain, noSentence, readCookie } from "../api.js";

const AdminAuthContext = createContext(null);

/**
 * Calls a staff (/admin) endpoint. The staff session lives in an HttpOnly cookie that
 * page scripts cannot read, so this only sends cookies and, on writes, the CSRF token.
 * @param {string} path
 * @param {RequestInit} [opts]
 */
export async function adminApi(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("luna_connect_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  // Force credentials after opts so callers cannot drop the session cookie.
  const res = await fetchOrExplain(path, { ...opts, credentials: "include", headers });
  const text = await res.text();
  let data = {};
  let parsed = true;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    parsed = false;
    data = { message: text };
  }
  if (!res.ok) {
    const sentence = parsed ? data.message || data.error : "";
    const err = /** @type {Error & { status?: number }} */ (
      new Error(sentence || noSentence(res.status))
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

function accountFrom(res) {
  return { id: res.id, email: res.email, name: res.name, has_2fa: res.has_2fa };
}

export function AdminAuthProvider({ children }) {
  const { pathname } = useLocation();
  const onAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const [ready, setReady] = useState(false);
  const [probed, setProbed] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Earlier builds kept the staff token in page storage. Drop any copy left behind.
    try {
      localStorage.removeItem("luna-connect-admin-token");
      localStorage.removeItem("luna-connect-admin-account");
    } catch {
      /* storage blocked: nothing to clear */
    }
  }, []);

  useEffect(() => {
    // Only staff pages ask who is signed in; customer pages never touch /admin.
    if (!onAdmin || probed) return;
    setProbed(true);
    adminApi("/admin/me")
      .then((me) => {
        setAccount(accountFrom(me));
        setIsAuthenticated(true);
      })
      .catch(() => {
        setAccount(null);
        setIsAuthenticated(false);
      })
      .finally(() => setReady(true));
  }, [onAdmin, probed]);

  const login = useCallback(async (email, password, totpCode) => {
    setLoading(true);
    try {
      const res = await adminApi("/admin/login", {
        method: "POST",
        body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
      });
      if (res.requires_2fa) return res;
      setAccount(accountFrom(res));
      setIsAuthenticated(true);
      setReady(true);
      return res;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await adminApi("/admin/logout", { method: "POST", body: "{}" });
    } catch {
      /* the local state still signs out; the server clears an expired session itself */
    }
    setIsAuthenticated(false);
    setAccount(null);
  }, []);

  const updateAccount = useCallback((updater) => {
    setAccount((prev) => (typeof updater === "function" ? updater(prev) : { ...prev, ...updater }));
  }, []);

  return (
    <AdminAuthContext.Provider value={{ ready, isAuthenticated, account, loading, login, logout, updateAccount }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
