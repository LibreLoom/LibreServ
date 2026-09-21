import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./useAuth";

/**
 * useMfaAvailability fetches GET /auth/mfa/availability, which reports which
 * enrollment methods the server can actually service right now:
 *   { totp, email, passkey, security_key } — each a boolean.
 *
 * The setup wizard's "choose a method" step (and the My Account picker) use
 * this to hide methods the server can't service (e.g. email when no SMTP
 * sender is wired or the account has no email; WebAuthn when no verifier is
 * wired; TOTP when the at-rest encryption key isn't configured) instead of
 * letting the user pick one and fail partway through.
 *
 * Returns { availability, loading, error, authError, refresh } where `availability`
 * is null while loading. `authError` is true when the failure was caused by an
 * expired session, so callers can offer "log in again" instead of a useless
 * "Try again" button. Treat a fetch failure permissively (show all methods)
 * so the user can still attempt enrollment — the setup endpoint will surface
 * a clear error if a method truly isn't configured.
 */
export default function useMfaAvailability() {
  const { request } = useAuth();
  const [availability, setAvailability] = useState(/** @type {Record<string, boolean> | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [authError, setAuthError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAuthError(false);
    try {
      const res = await request("/auth/mfa/availability");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load available methods.");
      setAvailability({
        totp: !!data.totp,
        email: !!data.email,
        passkey: !!data.passkey,
        security_key: !!data.security_key,
      });
    } catch (err) {
      const isAuth = err.name === "AuthError";
      setAuthError(isAuth);
      setError(err.message || "Couldn't load available methods.");
      setAvailability(null); // null → caller falls back to showing all methods
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        setLoading(true);
        const res = await request("/auth/mfa/availability", { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't load available methods.");
        if (cancelled) return;
        setAvailability({
          totp: !!data.totp,
          email: !!data.email,
          passkey: !!data.passkey,
          security_key: !!data.security_key,
        });
        setError(null);
        setAuthError(false);
      } catch (err) {
        if (controller.signal.aborted || cancelled) return;
        const isAuth = err.name === "AuthError";
        setAuthError(isAuth);
        setError(err.message || "Couldn't load available methods.");
        setAvailability(null);
      } finally {
        if (!cancelled && !controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [request]);

  return { availability, loading, error, authError, refresh };
}