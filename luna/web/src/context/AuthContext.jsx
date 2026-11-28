/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UNAUTHORIZED_EVENT, apiFetch, getJson, postJson } from "../lib/api";

const AuthContext = createContext(undefined);

// Pages you may visit before Luna is set up. Everything else bounces to the
// setup wizard so a fresh Luna always boots straight into setup instead of
// an app with no account. /recover also stays reachable before an account
// exists so a recovery file can create a new Admin account at boot.
const ALLOWED_DURING_SETUP = ["/setup", "/login", "/recover"];

// React Router matches /recover and /recover/ as the same route, but the
// browser reports the literal pathname. Normalize before comparing so a
// trailing slash cannot bounce someone off a page they are already on.
function normalizePath(path) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

// A startup or recovery attempt can be blackholed (a firewall drops the
// packet instead of refusing it). Without a bound, browser fetch keeps the
// in-flight guard shut for minutes and the app stalls. Abort a whole attempt
// that has not answered by now — startup refresh, recovery probe and the
// refresh behind it — so the next tick retries and a stalled read cannot
// write stale state later.
const AUTH_READ_TIMEOUT_MS = 5000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [setup, setSetup] = useState(null);
  const [hasAdmin, setHasAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  // True after a live session was found dead, so LoginPage can say why.
  const [sessionEnded, setSessionEnded] = useState(false);
  // Bumped on each confirmed session death. LoginPage keys its "signed out"
  // toast to this number, so a second death in one page session is announced
  // again without a StrictMode double-effect announcing the same death twice.
  const [sessionEndGeneration, setSessionEndGeneration] = useState(0);
  // True when Luna answered none of the startup requests (a restart after an
  // update). RequireAuth shows a "can't reach Luna" notice until a poll sees
  // Luna answer again — see below.
  const [unreachable, setUnreachable] = useState(false);
  const navigate = useNavigate();

  // Keep the latest navigate in a ref so the startup effect below can stay
  // stable. In a BrowserRouter, useNavigate() returns a NEW function whenever
  // the route changes (it closes over the current pathname), so putting it in
  // the effect's deps made the effect — and its refresh() — re-run on every
  // navigation, clobbering the just-logged-in user with a stale /auth/me read.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  // A login creates a newer session than any auth read still in flight. Bump
  // this so a late `me: null` from startup or recovery cannot clear the new
  // user or route to setup, even when its fetch ignored an abort.
  const authGenerationRef = useRef(0);
  // Abort handle for the current startup/recovery attempt. login() cancels it
  // so a stalled poll cannot keep its in-flight guard after a fresh session.
  const activeControllerRef = useRef(null);

  // Re-fetch the signed-in user and the setup state. Called at startup and
  // after big state changes (creating the admin account, finishing setup) so
  // the routes guarded by RequireAuth see the fresh state instead of the
  // snapshot from page load.
  //
  // A /auth/me that FAILS (network blip, 5xx) is treated as "unknown" and the
  // current user is kept, so a transient error can't silently log someone out.
  // Only a clean 200 with a null body (not signed in) clears the user.
  //
  // Returns what it learned. `unreachable: true` means every request failed —
  // exactly what a Luna restarting after an update looks like. Nothing was
  // learned then: the previous state is kept and the other fields are null, so
  // callers must never read them as "no admin, no setup".
  //
  // Pass `{ signal }` to cancel a refresh (the startup and recovery deadlines
  // do). A cancelled refresh still returns what it learned so a caller can
  // validate freshness, but it writes no provider state: by then a newer
  // attempt or a login owns that state. Called with no args everywhere else.
  /** @param {{ signal?: AbortSignal }} [options] */
  const refresh = useCallback(async (options = {}) => {
    const { signal } = /** @type {{ signal?: AbortSignal }} */ (options);
    const generation = authGenerationRef.current;
    let me = null;
    let meFailed = false;
    try {
      me = await getJson("/api/v1/auth/me", { signal });
    } catch {
      meFailed = true;
    }
    let setupFailed = false;
    let statusFailed = false;
    const [setupState, authStatus] = await Promise.all([
      getJson("/api/v1/setup", { signal }).catch(() => { setupFailed = true; return null; }),
      getJson("/api/v1/auth/status", { signal }).catch(() => { statusFailed = true; return null; }),
    ]);

    // Luna unreachable: every request failed, which is what a restart after an
    // update looks like. That is NOT a fresh Luna — reading it as one would
    // send the user to the setup wizard and make a restart look like lost
    // setup. Keep the state we already have and say nothing was learned.
    if (meFailed && setupFailed && statusFailed) {
      return { me: null, setup: null, hasAdmin: null, unreachable: true };
    }

    // If authStatus succeeded, use has_admin.
    // If authStatus was unreachable or unmocked, infer from me or setupState:
    // a signed-in user or a completed setup implies an account exists.
    const adminExists = authStatus != null
      ? Boolean(authStatus.has_admin)
      : Boolean(me || setupState?.setup_completed);
    const effectiveSetup = setupState || (!adminExists ? { setup_completed: false } : null);

    // An attempt whose deadline passed, or which began before a login, must
    // not commit: its signal is aborted or a newer session owns the state.
    // Returning the data lets callers that check freshness still use it.
    if (!signal?.aborted && generation === authGenerationRef.current) {
      if (!meFailed) setUser(me || null);
      setHasAdmin(adminExists);
      if (effectiveSetup) setSetup(effectiveSetup);
    }
    return { me: me || null, setup: effectiveSetup, hasAdmin: adminExists, unreachable: false };
  }, []);

  // Startup-only: restore the session (or send a fresh Luna to the wizard)
  // exactly once. Deps are stable (refresh never changes), so this runs a
  // single time on mount — NOT on every route change.
  useEffect(() => {
    let alive = true;
    let pollTimer = 0;
    // The current attempt's deadline timer. Hoisted to effect scope so
    // unmount can cancel a hung startup refresh or probe, not just the poll.
    let probeTimer = 0;
    function clearDeadline() {
      if (probeTimer) {
        window.clearTimeout(probeTimer);
        probeTimer = 0;
      }
    }
    function cancelAttempt() {
      clearDeadline();
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
        activeControllerRef.current = null;
      }
    }
    // Shared by startup and by the recovery poll: decide where a known Luna
    // should put this tab, without touching the URL of a set-up one.
    //
    // Read the path when the decision is made, not once when this effect
    // mounts. The startup read can be pending while the person navigates —
    // e.g. from /login to the recovery form — and routing by the mount-time
    // path would yank them off recovery and into setup when the read lands.
    // Reading window.location directly (instead of subscribing to the router)
    // keeps this effect one-shot: a useLocation hook here re-rendered the
    // provider on every ?file= / #hash change, so opening a file re-rendered
    // the whole app tree.
    function routeAfterRefresh({ me, setup: setupState, hasAdmin: adminExists }) {
      const path = normalizePath(typeof window !== "undefined" ? window.location.pathname : "");
      const needsSetup = !adminExists || Boolean(setupState && setupState.setup_completed === false);
      if (!adminExists && !me && path !== "/recover") {
        if (path !== "/setup") {
          navigateRef.current("/setup", { replace: true });
        }
      } else if (needsSetup && !ALLOWED_DURING_SETUP.includes(path)) {
        navigateRef.current("/setup", { replace: true });
      }
    }

    // Luna never answered. We know nothing about it, so stay on this page
    // with a "can't reach Luna" notice and short-poll until it answers; a
    // restart is not a fresh Luna and must not send anyone to the wizard.
    function startRecoveryPoll() {
      setUnreachable(true);
      setLoading(false);
      // A tick can outlive the 2 s interval (a slow answer, then refresh).
      // Never start a second one on top of it.
      let polling = false;
      // Every tick gets an id. Only the current, non-aborted attempt may act
      // on its result; a timed-out attempt may still be settling, but it is
      // inert and cannot overwrite a newer recovery or login.
      let attemptId = 0;
      pollTimer = window.setInterval(() => {
        if (polling) return;
        polling = true;
        const thisAttempt = ++attemptId;
        const controller = new AbortController();
        activeControllerRef.current = controller;
        const signal = controller.signal;
        const generation = authGenerationRef.current;
        // Race the whole attempt against a deadline. A blackholed fetch does
        // not reject on its own, so aborting its socket is backed by a timer
        // that frees the guard no matter what fetch decides to do. The same
        // signal goes to refresh()'s requests, so a stalled refresh cannot
        // commit state after the deadline.
        const timedOut = new Promise((_, reject) => {
          probeTimer = window.setTimeout(() => {
            controller.abort();
            reject(new Error("Luna recovery probe timed out"));
          }, AUTH_READ_TIMEOUT_MS);
        });
        (async () => {
          try {
            const attempt = (async () => {
              // apiFetch resolves on any HTTP answer — 401, 403 and 500 all
              // mean Luna is back. It throws only when no answer arrived,
              // which is the one case where Luna is still restarting.
              await apiFetch("/api/v1/auth/me", { cache: "no-store", signal });
              return refresh({ signal });
            })();
            const next = await Promise.race([attempt, timedOut]);
            // A deadline, a newer attempt, a login, or unmount made this
            // result stale. It must not clear the poll, clear unreachable,
            // route, or read as a fresh Luna.
            if (!alive || signal.aborted || thisAttempt !== attemptId
              || generation !== authGenerationRef.current || next.unreachable) return;
            if (pollTimer) window.clearInterval(pollTimer);
            pollTimer = 0;
            // Abort on success too: cancel any leftover request from this
            // attempt (and clear the deadline) before acting on the result.
            cancelAttempt();
            setUnreachable(false);
            routeAfterRefresh(next);
          } catch {
            // No HTTP answer (a failed request or a timed-out blackhole):
            // Luna is still down. The next tick tries again.
          } finally {
            clearDeadline();
            if (activeControllerRef.current === controller) activeControllerRef.current = null;
            polling = false;
          }
        })();
      }, 2000);
    }

    (async () => {
      // Startup used to run refresh() without a signal: one blackholed
      // /auth/me left protected routes blank forever and never started the
      // recovery poll. Give it the same deadline and abort handle as a probe.
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const signal = controller.signal;
      const generation = authGenerationRef.current;
      const timedOut = new Promise((_, reject) => {
        probeTimer = window.setTimeout(() => {
          controller.abort();
          reject(new Error("Luna startup refresh timed out"));
        }, AUTH_READ_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([refresh({ signal }), timedOut]);
        if (!alive) return;
        if (generation !== authGenerationRef.current) {
          // A login overtook this read; it owns the state and the URL.
          setLoading(false);
          return;
        }
        clearDeadline();
        if (activeControllerRef.current === controller) activeControllerRef.current = null;
        if (signal.aborted) {
          // The deadline won the race against the answer: nothing was learned.
          startRecoveryPoll();
          return;
        }
        setUnreachable(result.unreachable);
        const { me, setup: setupState, hasAdmin: adminExists, unreachable } = result;
        if (unreachable) {
          startRecoveryPoll();
          return;
        }
        routeAfterRefresh({ me, setup: setupState, hasAdmin: adminExists });
        setLoading(false);
      } catch {
        // Only the deadline rejects: refresh() swallows request failures, and
        // a login or unmount settles the race with refresh()'s return value.
        if (!alive || generation !== authGenerationRef.current) return;
        clearDeadline();
        if (activeControllerRef.current === controller) activeControllerRef.current = null;
        startRecoveryPoll();
      } finally {
        clearDeadline();
        if (activeControllerRef.current === controller) activeControllerRef.current = null;
      }
    })();
    return () => {
      alive = false;
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = 0;
      cancelAttempt();
    };
  }, [refresh]);

  // Any API call that comes back 401 lands here. Ask /auth/me whether the
  // session really ended (a 401 can also be a wrong password or device token);
  // if it did, drop the user so RequireAuth shows the sign-in form in place of
  // this page — the URL never moves, so every open tab keeps its place and
  // returns to it after signing in.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const checkingRef = useRef(false);
  useEffect(() => {
    async function onUnauthorized() {
      if (!userRef.current || checkingRef.current) return;
      checkingRef.current = true;
      try {
        const me = await getJson("/api/v1/auth/me");
        if (!me && userRef.current) {
          setSessionEndGeneration((generation) => generation + 1);
          setSessionEnded(true);
          setUser(null);
        }
      } catch {
        // Couldn't reach Luna — keep the user; a blip is not a sign-out.
      } finally {
        checkingRef.current = false;
      }
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (username, password) => {
    // Cookie session only — login JSON has no JWT. fetch uses credentials: include.
    const me = await postJson("/api/v1/auth/login", { username, password });
    // This session is newer than any startup or recovery read still in flight.
    // Invalidate those reads so a late `me: null` cannot clear this user or
    // route to setup; aborting frees a stalled probe's in-flight guard too.
    authGenerationRef.current += 1;
    activeControllerRef.current?.abort();
    setSessionEnded(false);
    setUser(me);
    return me;
  }, []);

  const register = useCallback(async (username, displayName, password, setupSecret) => {
    const body = {
      username,
      display_name: displayName,
      password,
    };
    if (setupSecret) body.setup_secret = setupSecret;
    const created = await postJson("/api/v1/auth/register", body);
    return created;
  }, []);

  const logout = useCallback(async () => {
    try { await postJson("/api/v1/auth/logout", {}); } catch { /* session already gone */ }
    setUser(null);
  }, []);

  // Drop the session in this tab without touching the URL, so RequireAuth
  // shows the sign-in form in place of the page you were on. Flows that end
  // the session themselves (password change, sign out everywhere, an update
  // that restarts Luna) use this instead of bouncing to /login — every open
  // tab then keeps its place and comes back to it after signing in.
  const endSession = useCallback(() => {
    setSessionEnded(false);
    setUser(null);
  }, []);

  // Stable between renders so consumers only update when auth state changes.
  const value = useMemo(
    () => ({
      user, setup, hasAdmin, loading, sessionEnded, sessionEndGeneration, unreachable,
      login, register, logout, endSession, refresh,
    }),
    [
      user, setup, hasAdmin, loading, sessionEnded, sessionEndGeneration, unreachable,
      login, register, logout, endSession, refresh,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}

export function useOptionalAuth() {
  return useContext(AuthContext) ?? null;
}
