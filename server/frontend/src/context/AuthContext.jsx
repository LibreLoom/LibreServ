import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api, { AuthError } from "../lib/api";
import { AuthContext } from "./AuthContextContext";

export function AuthProvider({ children, queryClient }) {
  const [me, setMe] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [initialized, setInitialized] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let isMounted = true;
    async function initAuth() {
      try {
        // Check setup status first
        const setupResponse = await api("/setup/status");
        const setupData = await setupResponse.json();

        // If setup is not complete, keep the user on the public pages that are
        // allowed during setup. Redirect everything else to /setup so strangers
        // can't browse the app before the wizard finishes.
        const allowedDuringSetup =
          location.pathname === "/setup" ||
          location.pathname === "/login" ||
          location.pathname === "/reset-password" ||
          location.pathname.startsWith("/invite/");
        if (
          setupData.setup_state?.status !== "complete" &&
          !allowedDuringSetup
        ) {
          if (isMounted) {
            navigate("/setup");
            setInitialized(true);
          }
          return;
        }

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- location.pathname intentionally omitted: auth state does not change on navigation
  }, [navigate]);

  const login = useCallback(async (username, password) => {
    const res = await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    // MFA step: password valid but the account requires a second factor.
    // Session is NOT established yet — surface the challenge to the caller.
    if (data?.status === "mfa_required") {
      return {
        status: "mfa_required",
        mfaToken: data.mfa_token,
        methods: Array.isArray(data.methods) ? data.methods : [],
      };
    }
    // Success — session cookie is set; hydrate session state.
    const [meResponse, csrfResponse] = await Promise.all([
      api("/auth/me"),
      api("/auth/csrf"),
    ]);
    const meJSON = await meResponse.json();
    const csrfJSON = await csrfResponse.json();
    setMe(meJSON);
    setCsrfToken(csrfJSON.csrf_token);
    queryClient?.invalidateQueries({ queryKey: ["user"] });
    return { status: "ok" };
  }, [queryClient]);

  // MFA challenge (e.g. trigger an email OTP, or get a WebAuthn challenge).
  const mfaChallenge = useCallback(async (mfaToken, type) => {
    const res = await api("/auth/mfa/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_token: mfaToken, type }),
      noRetry: true,
    });
    return res.json();
  }, []);

  // Re-hydrate the session after it is established mid-flow (e.g. once the setup
  // wizard creates the admin account and sets auth cookies). Fetches me/csrf
  // independently so a missing /auth/me never blocks the CSRF token.
  const refreshAuth = useCallback(async () => {
    try {
      const meResponse = await api("/auth/me");
      setMe(meResponse.ok ? await meResponse.json() : null);
    } catch {
      setMe(null);
    }
    try {
      const csrfResponse = await api("/auth/csrf");
      setCsrfToken((await csrfResponse.json()).csrf_token);
    } catch {
      setCsrfToken(null);
    }
  }, []);

  // MFA verify — on success the session is established. (noRetry: a 401 here
  // means a wrong code, not a stale session — don't trigger the token refresh.)
  const mfaVerify = useCallback(async (mfaToken, type, payload) => {
    await api("/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_token: mfaToken, type, payload }),
      noRetry: true,
    });
    const [meResponse, csrfResponse] = await Promise.allSettled([
      api("/auth/me"),
      api("/auth/csrf"),
    ]);
    if (meResponse.status === "fulfilled") {
      try { setMe(await meResponse.value.json()); } catch { /* ignore JSON errors; still have refreshAuth fallback */ }
    }
    if (csrfResponse.status === "fulfilled") {
      try { setCsrfToken((await csrfResponse.value.json()).csrf_token); } catch { /* ignore JSON errors; still have refreshAuth fallback */ }
    }
    if (meResponse.status === "rejected" || csrfResponse.status === "rejected") {
      refreshAuth().catch(() => {});
    }
    queryClient?.invalidateQueries({ queryKey: ["user"] });
  }, [refreshAuth, queryClient]);

  const mfaRecover = useCallback(async (mfaToken, recoveryCode) => {
    await api("/auth/mfa/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfa_token: mfaToken, recovery_code: recoveryCode }),
      noRetry: true,
    });
    const [meResponse, csrfResponse] = await Promise.allSettled([
      api("/auth/me"),
      api("/auth/csrf"),
    ]);
    if (meResponse.status === "fulfilled") {
      try { setMe(await meResponse.value.json()); } catch { /* ignore JSON errors; still have refreshAuth fallback */ }
    }
    if (csrfResponse.status === "fulfilled") {
      try { setCsrfToken((await csrfResponse.value.json()).csrf_token); } catch { /* ignore JSON errors; still have refreshAuth fallback */ }
    }
    if (meResponse.status === "rejected" || csrfResponse.status === "rejected") {
      refreshAuth().catch(() => {});
    }
  }, [refreshAuth]);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Continue with cleanup even if logout request fails
    } finally {
      setMe(null);
      setCsrfToken(null);
      queryClient?.invalidateQueries({ queryKey: ["user"] });
    }
  }, [queryClient]);

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
    () => ({ me, csrfToken, login, mfaChallenge, mfaVerify, mfaRecover, request, logout, initialized, refreshAuth }),
    [me, csrfToken, login, mfaChallenge, mfaVerify, mfaRecover, request, logout, initialized, refreshAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
