/**
 * HACK — advisory edit lock for `.drawio` files.
 *
 * Stopgap standing in for real-time collaboration: opening a diagram in the
 * editor opens a WebSocket to lunad (`/api/v1/diagrams/lock/ws`); the socket
 * IS the hold — it stays open in backgrounded tabs (where setInterval
 * heartbeats get throttled and used to silently expire the lock, letting a
 * later opener steal precedence), releases instantly on close, and the
 * server drops dead peers on a pong timeout. A second opener gets
 * "X is editing this diagram" with read-only/download/close instead of a
 * silent clobber. The write path refuses non-holder saves with 409, so a
 * stale editor can't overwrite.
 *
 * The server assigns each acquire a generation (`gen` in the `held`
 * message). This hook only ever listens to the socket it most recently
 * opened — an older, half-dead socket's close/error events are ignored, so
 * a stale connection can neither spawn phantom reconnects nor release the
 * lock its replacement holds. The release POST echoes `gen` for the same
 * reason: a keepalive from a dying page can't free the newer socket's hold.
 *
 * On an unexpected socket drop the client re-acquires — a lunad restart
 * clears RAM locks, so reconnecting quietly re-holds instead of crying
 * wolf; "lost" only fires when someone genuinely holds the file now. A
 * holder-less `lost` from the server means the lock is simply gone — that's
 * treated like a drop and re-acquired silently too.
 *
 * Deliberately NOT shared with other file kinds — office files have real
 * EuroOffice collab; text/forms are out of scope. When real diagram collab
 * lands, this whole file and its call sites go away.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { withCsrfHeaders } from "../../../lib/api.js";
import { driveSource, useFileSource } from "../../../lib/fileSource.jsx";

const RELEASE_URL = "/api/v1/diagrams/lock/release";
/** A socket that connects but never answers is treated like no socket. */
const OPEN_TIMEOUT_MS = 10_000;
/**
 * Bounded reconnect tries on a dropped socket — exponential backoff,
 * capped so a dead lunad doesn't spin forever. Exhaustion → "lost", since
 * an unverifiable hold must not keep overwriting the shared file.
 */
const MAX_RECONNECT_ATTEMPTS = 6;
/**
 * No input for this long → the lock becomes "grabbable": still held (saves
 * keep landing, coming back is seamless) but a new opener may take it, and
 * the displaced session gets the same "lost" notice as any other takeover.
 * Connected-but-idle is the case the socket alone can't see — a parked
 * tab answers pongs forever while holding the file hostage.
 */
const IDLE_AFTER_MS = 5 * 60_000;
/** Parent-window input events that count as activity. */
const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
];

/** One session id per editor instance — see `session` on the server side. */
function newSession() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Same-origin member lock socket URL — mirrors browserCollabWsUrl. */
export function diagramLockWsUrl(driveId, path, session) {
  return driveSource.diagramLockWsUrl(driveId, path, session);
}

/**
 * Fire-and-forget release for tab close/pagehide. `navigator.sendBeacon`
 * can't attach the X-CSRF-Token header lunad requires on cookie-authed
 * POSTs (it would answer 403), so the close path uses `fetch` with
 * `keepalive` — same one-way semantics, headers intact. Socket teardown is
 * the primary release; this covers the browser killing the page first. The
 * generation is sent so a late keepalive can't free a lock the newer
 * connection already holds.
 */
function releaseBeacon(driveId, path, session, gen) {
  try {
    fetch(RELEASE_URL, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: withCsrfHeaders("POST", { "Content-Type": "application/json" }),
      body: JSON.stringify({ drive_id: driveId, path, session, gen }),
    }).catch(() => {});
  } catch {
    // Best-effort — socket teardown covers whatever this misses.
  }
}

/**
 * @param {{ driveId: string, path: string }} target
 * @returns {{
 *   status: "off" | "held" | "blocked" | "lost",
 *   holder: string,
 *   selfHold: boolean,
 *   session: string,
 *   acquire: () => Promise<"held" | "blocked" | "failed">,
 *   markLost: (holder?: string) => void,
 *   noteActivity: () => void,
 *   saveHeaders: () => object,
 * }}
 */
export function useDiagramLock({ driveId, path }) {
  const source = useFileSource();
  const guest = source.guest === true;
  const sessionRef = useRef(newSession());
  const [status, setStatus] = useState(
    /** @type {"off" | "held" | "blocked" | "lost"} */ ("off"),
  );
  const [holder, setHolder] = useState("");
  /** The blocker is the same user's other tab/session — copy differs. */
  const [selfHold, setSelfHold] = useState(false);
  const heldRef = useRef(false);
  /** The generation the server gave the live hold — renew/release scope. */
  const genRef = useRef(0);
  /** True while the client has reported this hold as idle (grabbable). */
  const idleRef = useRef(false);
  const idleTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const wsRef = useRef(/** @type {WebSocket | null} */ (null));
  /** Set on unmount/close so socket teardown doesn't trigger reconnect. */
  const intentionalRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const openTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  /** Pending acquire() promise's resolver — settled by the first reply. */
  const settleRef = useRef(/** @type {((r: "held" | "blocked" | "failed") => void) | null} */ (null));
  /** The shared in-flight acquire promise — overlapping callers get one. */
  const pendingRef = useRef(/** @type {Promise<"held" | "blocked" | "failed"> | null} */ (null));
  const connectRef = useRef(() => {});
  const scheduleReconnectRef = useRef(() => {});
  const noteActivityRef = useRef(() => {});

  /** Report the idle flag to the server over the live hold socket. */
  const sendIdle = useCallback((idle) => {
    const ws = wsRef.current;
    if (!heldRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "idle", idle }));
    } catch {
      // The close path re-arms the state on reconnect anyway.
    }
  }, []);

  /**
   * Input happened — in the page or inside the same-origin editor iframe
   * (the editor calls this on its document listeners and on every drawio
   * embed message). Resets the idle timer; coming back from idle reports
   * `idle:false` so the hold stops being grabbable.
   */
  const noteActivity = useCallback(() => {
    if (idleTimerRef.current != null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (idleRef.current) {
      idleRef.current = false;
      sendIdle(false);
    }
    if (heldRef.current && !intentionalRef.current) {
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        if (!heldRef.current) return; // hold lost while the timer slept
        idleRef.current = true;
        sendIdle(true);
      }, IDLE_AFTER_MS);
    }
  }, [sendIdle]);

  const settle = useCallback((result) => {
    if (openTimerRef.current != null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    const resolve = settleRef.current;
    settleRef.current = null;
    pendingRef.current = null;
    resolve?.(result);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalRef.current || retryTimerRef.current != null) return;
    if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      // Can't verify the hold anymore — divert saves to copies.
      heldRef.current = false;
      setStatus("lost");
      return;
    }
    const delay = Math.min(1000 * 2 ** attemptsRef.current, 15_000);
    attemptsRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      try {
        connectRef.current();
      } catch {
        scheduleReconnectRef.current();
      }
    }, delay);
  }, []);

  /**
   * Open the hold socket. The server replies `held` (we hold it),
   * `locked` (someone else does — holder name plus `self` when it's this
   * user's own other tab), or `lost` (this socket's hold is gone —
   * with a holder it was taken; without one the lock simply vanished).
   */
  const connectSocket = useCallback(() => {
    const ws = new WebSocket(
      source.diagramLockWsUrl(driveId, path, sessionRef.current),
    );
    // Supersede any older socket first: only wsRef's socket may drive
    // state, so a stale connection can neither settle a new acquire, spawn
    // reconnects, nor free the lock its replacement holds.
    const prev = wsRef.current;
    wsRef.current = ws;
    try {
      prev?.close();
    } catch {
      // ignore — already closing
    }

    ws.addEventListener("message", (ev) => {
      if (wsRef.current !== ws) return;
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const name =
        typeof msg?.holder === "string" && msg.holder ? msg.holder : "";
      if (msg?.type === "held") {
        heldRef.current = true;
        genRef.current = typeof msg.gen === "number" ? msg.gen : 0;
        attemptsRef.current = 0;
        setSelfHold(false);
        setStatus("held");
        settle("held");
        // Re-arm the idle watcher — and if this socket is a reconnect
        // while still idle, restore the grabbable flag server-side.
        if (idleRef.current) {
          sendIdle(true);
        } else {
          noteActivity();
        }
      } else if (msg?.type === "locked") {
        heldRef.current = false;
        setHolder(name || "Someone else");
        setSelfHold(msg?.self === true);
        if (settleRef.current) {
          // Initial open — the caller shows the who's-editing card.
          setStatus("blocked");
          settle("blocked");
        } else {
          // Reconnect found a real holder — the lock is genuinely gone.
          setStatus("lost");
        }
      } else if (msg?.type === "lost") {
        if (name) {
          // Verified takeover — a real holder is named. Fires both for an
          // outright loss and for someone grabbing our idle lock.
          heldRef.current = false;
          idleRef.current = false;
          if (idleTimerRef.current != null) {
            clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
          }
          setHolder(name);
          setStatus("lost");
        } else {
          // The lock is simply gone, not held — same as a dropped
          // socket: quietly re-acquire instead of crying wolf.
          scheduleReconnect();
        }
      }
    });

    ws.addEventListener("close", () => {
      if (wsRef.current !== ws) return; // stale socket — ignore entirely
      wsRef.current = null;
      if (settleRef.current) {
        // Never got an answer — degrade to editing without a lock.
        settle("failed");
        return;
      }
      if (!intentionalRef.current && heldRef.current) scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (wsRef.current !== ws) return;
      // Mid-session errors are always followed by close, which drives the
      // reconnect path; this settle only matters for a failed first open.
      settle("failed");
    });
  }, [source, driveId, path, settle, scheduleReconnect, sendIdle, noteActivity]);
  connectRef.current = connectSocket;
  scheduleReconnectRef.current = scheduleReconnect;
  noteActivityRef.current = noteActivity;

  /**
   * Try to take the lock. Idempotent: an already-held session returns
   * "held" and overlapping callers share one in-flight attempt — a second
   * call never opens a second socket. "failed" (endpoint missing, network
   * down) is NOT "blocked": the lock is advisory, so acquire failure
   * degrades to the pre-lock behavior — open the editor anyway — rather
   * than gate editing behind a stopgap endpoint.
   * @returns {Promise<"held" | "blocked" | "failed">}
   */
  const acquire = useCallback(() => {
    if (typeof WebSocket !== "function") return Promise.resolve("failed");
    if (heldRef.current) return Promise.resolve("held");
    if (pendingRef.current) return pendingRef.current;
    const pending = new Promise((resolve) => {
      settleRef.current = resolve;
      openTimerRef.current = setTimeout(() => {
        settle("failed");
        try {
          wsRef.current?.close();
        } catch {
          // ignore
        }
      }, OPEN_TIMEOUT_MS);
      try {
        connectRef.current();
      } catch {
        settle("failed");
      }
    });
    pendingRef.current = pending;
    return pending;
  }, [settle]);

  /**
   * The write path just answered 409 diagram_locked — treat the lock as
   * lost so the editor shows the save-a-download modal instead of
   * retrying an overwrite that can't land.
   * @param {string} [name]
   */
  const markLost = useCallback((name) => {
    heldRef.current = false;
    idleRef.current = false;
    if (name) setHolder(name);
    setStatus("lost");
  }, []);

  /**
   * Headers the save path must send — the session id ties the write to the
   * holding editor instance, so a save from a session that lost its lock
   * (e.g. after an idle grab) is refused. Members and guests alike.
   */
  const saveHeaders = useCallback(
    () => ({ "X-Diagram-Session": sessionRef.current }),
    [],
  );

  // Release on unmount/pagehide — the socket close is the real signal;
  // the keepalive POST covers the page being killed before it lands.
  // Guests have no member release route: socket teardown is the only one.
  useEffect(() => {
    // A fresh mount for a different file re-arms reconnect/release — the
    // latch only means "this instance is going away for good".
    intentionalRef.current = false;
    const session = sessionRef.current;
    const onPageHide = () => {
      if (heldRef.current && !guest) {
        releaseBeacon(driveId, path, session, genRef.current);
      }
    };
    // Input on the page chrome counts as activity; the editor iframe
    // reports its own (see noteActivity's callers).
    const onActive = () => noteActivityRef.current();
    window.addEventListener("pagehide", onPageHide);
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActive, { passive: true });
    }
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActive);
      }
      intentionalRef.current = true;
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      idleRef.current = false;
      if (retryTimerRef.current != null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (openTimerRef.current != null) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
      if (heldRef.current) {
        heldRef.current = false;
        if (!guest) releaseBeacon(driveId, path, session, genRef.current);
      }
    };
  }, [driveId, path, guest]);

  return {
    status,
    holder,
    selfHold,
    session: sessionRef.current,
    acquire,
    markLost,
    noteActivity,
    saveHeaders,
  };
}
