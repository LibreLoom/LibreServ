import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../lib/api";
import { AuthContext } from "./AuthContextContext";

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let isMounted = true;
    async function initAuth() {
      try {
        const [meResponse, csrfResponse] = await Promise.all([
          api("/auth/me"),
          api("/auth/csrf"),
        ]);
        if (isMounted) {
          const meJSON = await meResponse.json();
          const csrfJSON = await csrfResponse.json();
          setMe(meJSON);
          setCsrfToken(csrfJSON.csrf_token);
          setInitialized(true);
        }
      } catch {
        if (isMounted) {
          setMe(null);
          setCsrfToken(null);
          setInitialized(true);
        }
      }
    }
    initAuth();
    return () => {
      isMounted = false;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const [meResponse, csrfResponse] = await Promise.all([
      api("/auth/me"),
      api("/auth/csrf"),
    ]);
    const meJSON = await meResponse.json();
    const csrfJSON = await csrfResponse.json();
    setMe(meJSON);
    setCsrfToken(csrfJSON.csrf_token);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Continue with cleanup even if logout request fails
    } finally {
      setMe(null);
      setCsrfToken(null);
    }
  }, []);

  const request = useCallback(
    async (path, options = {}) => {
      const method = options.method?.toUpperCase() ?? "GET";
      const isWrite = ["POST", "PUT", "DELETE", "PATCH"].includes(method);
      const headers = {
        ...options.headers,
        ...(isWrite && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      };
      const response = await api(path, {
        ...options,
        method,
        headers,
      });
      return response;
    },
    [csrfToken],
  );

  const value = useMemo(
    () => ({ me, csrfToken, login, request, logout, initialized }),
    [me, csrfToken, login, request, logout, initialized],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
