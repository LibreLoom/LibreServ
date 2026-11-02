// @ts-nocheck -- deliberately replaces browser globals (fetch, XHR, WebSocket) with fakes
// The fake lunad: patches fetch, XMLHttpRequest and WebSocket in the page so the
// real app runs with no daemon. Dev-only — main.jsx imports this behind
// import.meta.env.DEV, so it never reaches the production bundle.
//
// Anything under /api (and /health) is answered here. An endpoint with no
// handler answers 501 and is recorded as "unhandled" so a tester never mistakes
// a missing mock for a real error state. A handler that throws something that is not
// an answer answers 500 "fake crashed: …" and is recorded too. Faults (errors,
// slowness, offline) are applied before the handler runs and can be changed live
// from the gallery.
import { Res, empty, fail, findRoute, get, handlerPatterns, json, patch, post, put, raw, route, del } from "./router.js";
import { ruleMatches } from "./faults.js";
import { freezeClock, realNow } from "./clock.js";
import { createXHR } from "./xhr.js";
import { idState, user as makeUser } from "./world.js";
import { tickJobs } from "./jobs.js";

// Handler files import their helpers from here.
export { Res, empty, fail, get, handlerPatterns, json, patch, post, put, raw, route, del };

const BODY_LOG_CHARS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class NetworkError extends Error {}
const abortError = () => new DOMException("Aborted", "AbortError");

/**
 * Starts the fake. Returns the control surface that the gallery drives through
 * `window.__lunaFake`.
 *
 * `restored` carries what a page reload must keep: faults (with their hit counts),
 * offline, latency and the clock.
 */
export function installFake({ world, scenario, now, restored = {} }) {
  const state = {
    world,
    scenario,
    offline: Boolean(restored.offline),
    latency: restored.latency || 0,
    faults: (restored.faults || []).map((f) => ({ ...f })),
    log: [],
    unhandled: new Map(),
    crashes: new Map(),
    hits: new Map(),
    down: null, // { from, until }: the server is restarting
  };
  const inflight = new Set();
  const listeners = new Set();
  let version = 0;
  let cached = null;
  let pending = false;

  // One notification per frame no matter how many requests finished in it. rAF is
  // paused in a hidden tab, so a timer backs it up.
  const notify = () => {
    pending = false;
    listeners.forEach((fn) => { try { fn(); } catch { /* listener gone */ } });
  };
  const emit = () => {
    version += 1;
    cached = null;
    if (pending) return;
    pending = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (pending) notify(); });
    setTimeout(() => { if (pending) notify(); }, 50);
  };

  const realFetch = window.fetch?.bind(window);
  const clock = freezeClock(now, restored.clock);

  // /s/... data calls are the public share pages; page loads are not fetches, so never caught here.
  const isFake = (path) => path.startsWith("/api/") || path === "/health" || path.startsWith("/s/");

  const lower = (headers) => {
    const out = {};
    if (!headers) return out;
    const entries = typeof headers.forEach === "function" && !Array.isArray(headers) && typeof headers.get === "function"
      ? [...headers.entries()]
      : Object.entries(headers);
    for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v);
    return out;
  };

  /**
   * opts: { signal, onPlan({waitMs}), minWait }. Resolves { status, text, bytes, headers };
   * rejects with NetworkError (offline / restarting) or an AbortError.
   */
  async function dispatch(method, rawUrl, body, headers = {}, opts = {}) {
    const url = new URL(rawUrl, window.location.origin);
    const path = url.pathname;
    const entry = { t: realNow(), method, path: path + url.search, status: 0, note: "", body: "" };
    state.log.unshift(entry);
    if (state.log.length > 200) state.log.pop();

    // Offline and abort cut a request short wherever it is waiting.
    let cut;
    const cancel = new Promise((_, reject) => { cut = reject; });
    cancel.catch(() => {});
    const handle = { cut };
    inflight.add(handle);
    const onAbort = () => cut(abortError());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const waitFor = (ms) => Promise.race([sleep(ms), cancel]);
    const checkAbort = () => { if (opts.signal?.aborted) throw abortError(); };
    const finish = (status, text, extra = {}) => {
      entry.status = status;
      entry.body = String(text ?? "").slice(0, BODY_LOG_CHARS);
      return { status, text: text ?? "", headers: {}, ...extra };
    };

    try {
      checkAbort();
      const t = realNow();
      if (state.offline || (state.down && t >= state.down.from && t < state.down.until)) {
        entry.note = state.offline ? "offline" : "restarting";
        throw new NetworkError();
      }

      const fault = state.faults.find((f) => f.on !== false && ruleMatches(f, method, path, url.search));
      const mode = fault ? String(fault.mode) : "";
      const slowMs = mode.startsWith("slow") ? Number(mode.split(":")[1]) || 4000 : 0;
      const hang = mode === "hang";
      const waitMs = hang ? Infinity : Math.max(state.latency + slowMs, opts.minWait || 0);
      opts.onPlan?.({ waitMs });
      if (fault) {
        fault.hits = (fault.hits || 0) + 1;
        entry.note = `fault: ${mode}`;
        if (fault.once) state.faults = state.faults.filter((f) => f !== fault);
      }
      if (mode === "offline") throw new NetworkError();
      if (hang) { emit(); await cancel; }
      if (waitMs) await waitFor(waitMs);
      checkAbort();
      if (state.offline) { entry.note = "offline"; throw new NetworkError(); }

      if (mode === "empty") return finish(200, "");
      if (mode === "badjson") return finish(200, "<html>oops");
      if (/^\d{3}$/.test(mode)) {
        return finish(Number(mode), JSON.stringify({ error: fault.message || `Injected ${mode}`, ...(fault.code ? { code: fault.code } : {}) }));
      }

      const found = findRoute(method, path);
      if (!found) {
        const key = `${method} ${path}`;
        state.unhandled.set(key, (state.unhandled.get(key) || 0) + 1);
        entry.note = "NO MOCK HANDLER";
        return finish(501, JSON.stringify({ error: `[mock] No handler for ${key}` }));
      }
      const hit = found.route;
      state.hits.set(hit.pattern, (state.hits.get(hit.pattern) || 0) + 1);

      const query = Object.fromEntries(url.searchParams);
      const user = state.world.users.find((u) => u.id === state.world.sessionUserId) || null;
      if (!hit.public && !user && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/s/")) {
        return finish(401, JSON.stringify({ error: "Sign in to continue." }));
      }

      let parsed = body;
      let rawBody = null;
      if (typeof body === "string") {
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      } else if (typeof FormData !== "undefined" && body instanceof FormData) {
        parsed = Object.fromEntries([...body.entries()]);
        rawBody = body;
      } else if (body != null) {
        rawBody = body;
        parsed = {};
      } else {
        parsed = {};
      }

      // Jobs make progress with time, whether or not anyone is asking about them.
      if (state.world.jobs?.length) tickJobs(state.world);

      let out;
      try {
        out = await hit.handler({
          world: state.world, user, params: found.params, query, body: parsed, raw: rawBody,
          headers: lower(headers), method, path, url, fake: control, signal: opts.signal, checkAbort,
        });
      } catch (err) {
        if (err instanceof Res) out = err;
        else if (err instanceof NetworkError || err?.name === "AbortError") throw err;
        else {
          const message = err?.message || String(err);
          const key = `${method} ${path}`;
          const seen = state.crashes.get(key);
          state.crashes.set(key, { message, count: (seen?.count || 0) + 1 });
          entry.note = "FAKE CRASHED";
          console.error("[fake lunad] handler crashed on", key, err);
          return finish(500, JSON.stringify({ error: `fake crashed: ${message}` }));
        }
      }
      checkAbort();
      if (!(out instanceof Res)) out = new Res(200, out === undefined ? {} : out);
      const text = out.body === undefined ? "" : JSON.stringify(out.body);
      entry.status = out.status;
      entry.body = out.bytes != null ? "(file contents)" : text.slice(0, BODY_LOG_CHARS);
      return { status: out.status, text, bytes: out.bytes, headers: out.headers };
    } finally {
      inflight.delete(handle);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!entry.status && !entry.note) entry.note = "cancelled";
      emit();
    }
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(rawUrl, window.location.origin).pathname;
    if (!isFake(path)) return realFetch(input, init);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    if (init.signal?.aborted) throw abortError();
    let result;
    try {
      result = await dispatch(method, rawUrl, init.body, init.headers || (typeof input === "object" ? input.headers : {}), { signal: init.signal });
    } catch (err) {
      if (err instanceof NetworkError) throw new TypeError("Failed to fetch");
      throw err;
    }
    return new Response(result.status === 204 ? null : (result.bytes ?? result.text), {
      status: result.status,
      headers: { "Content-Type": "application/json", ...result.headers },
    });
  };

  window.XMLHttpRequest = createXHR({ isFake, dispatch });

  // ── WebSocket: live co-editing needs the real daemon ───────────────────────
  const RealWS = window.WebSocket;
  class FakeWS extends EventTarget {
    constructor(url, protocols) {
      if (!String(url).includes("/api/")) return new RealWS(url, protocols);
      super();
      this.url = url;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 3;
        const ev = new Event("close");
        ev.code = 1006;
        this.onclose?.(ev);
        this.dispatchEvent(ev);
      }, 200);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = FakeWS;

  const control = {
    get world() { return state.world; },
    scenario,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The same object until something changes. */
    snapshot() {
      if (cached) return cached;
      cached = {
        version,
        offline: state.offline,
        latency: state.latency,
        faults: state.faults.map((f) => ({ hits: 0, ...f })),
        log: state.log.slice(0, 60).map((l) => ({ ...l })),
        unhandled: [...state.unhandled.entries()],
        crashed: [...state.crashes.entries()].map(([key, v]) => ({ key, ...v })),
        sessionUserId: state.world.sessionUserId,
        users: state.world.users.map((u) => ({ id: u.id, display_name: u.display_name, role: u.role })),
      };
      return cached;
    },
    setOffline(v) {
      state.offline = Boolean(v);
      if (state.offline) for (const h of [...inflight]) h.cut(new NetworkError());
      emit();
    },
    setLatency(ms) { state.latency = Math.max(0, Number(ms) || 0); emit(); },
    addFault(rule) { state.faults = [...state.faults, { id: Math.random().toString(36).slice(2, 8), on: true, hits: 0, ...rule }]; emit(); },
    setFaultOn(id, on) { state.faults = state.faults.map((f) => (f.id === id ? { ...f, on: Boolean(on) } : f)); emit(); },
    /** Adds a Member with no access yet (for "Sign in as"). Returns their id. */
    addMember() {
      const taken = state.world.users.filter((u) => u.role !== "admin").length;
      const created = makeUser({ username: `member${taken + 1}`, display_name: taken ? `Member ${taken + 1}` : "Sam", role: "user" });
      state.world.users.push(created);
      emit();
      return created.id;
    },
    removeFault(id) { state.faults = state.faults.filter((f) => f.id !== id); emit(); },
    clearFaults() { state.faults = []; emit(); },
    /** Kills the session as if it expired elsewhere; the next request answers 401. */
    expireSession() { state.world.sessionUserId = null; emit(); },
    /** Signs in as a user id, or signs out with null. The app has to reload to notice. */
    signInAs(id) { state.world.sessionUserId = id; emit(); },
    /** The server is down from `afterMs` for `forMs`, as when lunad restarts for an update. */
    restartServer(afterMs, forMs) {
      const t = realNow();
      state.down = { from: t + afterMs, until: t + afterMs + forMs };
      emit();
    },
    handlerPatterns() { return handlerPatterns().map((r) => `${r.method} ${r.pattern}`); },
    hitCounts() { return Object.fromEntries(state.hits); },
    /** What a page reload has to keep. */
    exportState() {
      return { world: state.world, faults: state.faults, offline: state.offline, latency: state.latency, clock, ids: idState() };
    },
  };
  window.__lunaFake = control;
  return control;
}
