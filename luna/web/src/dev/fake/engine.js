// @ts-nocheck -- deliberately replaces browser globals (fetch, XHR, WebSocket) with fakes
// The fake lunad: patches fetch, XMLHttpRequest and WebSocket in the page so the
// real app runs with no daemon. Dev-only — main.jsx imports this behind
// import.meta.env.DEV, so it never reaches the production bundle.
//
// Anything under /api (and /health) is answered here. An endpoint with no
// handler answers 501 and is recorded as "unhandled" so a tester never mistakes
// a missing mock for a real error state. Faults (errors, slowness, offline) are
// applied before the handler runs and can be changed live from the gallery.

const routes = [];

/** Register a handler. `pattern` uses :params, e.g. "/api/v1/drives/:id/summary". */
export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; });
  routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, public: Boolean(opts.public) });
}

export const get = (p, h, o) => route("GET", p, h, o);
export const post = (p, h, o) => route("POST", p, h, o);
export const put = (p, h, o) => route("PUT", p, h, o);
export const patch = (p, h, o) => route("PATCH", p, h, o);
export const del = (p, h, o) => route("DELETE", p, h, o);

/** A non-200 or custom-header answer. Plain return values mean 200 JSON. */
export class Res {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
export const json = (body, status = 200) => new Res(status, body);
export const fail = (status, error, code, extra = {}) =>
  new Res(status, { error, ...(code ? { code } : {}), ...extra });
export const empty = (status = 204) => new Res(status, undefined);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A rule matches "METHOD substring" or just "substring" against "METHOD path". */
function ruleMatches(rule, method, path) {
  const m = String(rule.match || "").trim();
  if (!m) return false;
  const parts = m.split(/\s+/);
  const wantMethod = parts.length > 1 ? parts[0].toUpperCase() : null;
  const frag = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
  if (wantMethod && wantMethod !== method) return false;
  if (frag.includes("*")) {
    const re = new RegExp(`^${frag.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}`);
    return re.test(path);
  }
  return path.includes(frag);
}

/**
 * Starts the fake. Returns the control surface that the gallery drives through
 * `window.__lunaFake`.
 */
export function installFake({ world, scenario, now }) {
  const state = {
    world,
    scenario,
    offline: false,
    latency: 0,
    faults: [],
    log: [],
    unhandled: new Map(),
    hits: new Map(),
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener gone */ } });
  const realFetch = window.fetch.bind(window);

  freezeClock(now);

  // /s/... data calls are the public share pages; page loads are not fetches, so never caught here.
  const isFake = (path) => path.startsWith("/api/") || path === "/health" || path.startsWith("/s/");

  async function dispatch(method, rawUrl, body, headers = {}) {
    const url = new URL(rawUrl, window.location.origin);
    const path = url.pathname;
    const entry = { t: Date.now(), method, path: path + url.search, status: 0, note: "" };
    state.log.unshift(entry);
    if (state.log.length > 200) state.log.pop();

    try {
      if (state.offline) { entry.note = "offline"; throw new NetworkError(); }
      if (state.latency) await delay(state.latency);

      const fault = state.faults.find((f) => f.on !== false && ruleMatches(f, method, path));
      if (fault) {
        entry.note = `fault: ${fault.mode}`;
        if (fault.once) state.faults = state.faults.filter((f) => f !== fault);
        const mode = String(fault.mode);
        if (mode === "offline") throw new NetworkError();
        if (mode === "hang") { await new Promise(() => {}); }
        if (mode.startsWith("slow")) await delay(Number(mode.split(":")[1]) || 4000);
        else if (mode === "empty") { entry.status = 200; return { status: 200, text: "", headers: {} }; }
        else if (mode === "badjson") { entry.status = 200; return { status: 200, text: "<html>oops", headers: {} }; }
        else if (/^\d{3}$/.test(mode)) {
          entry.status = Number(mode);
          const msg = fault.message || `Injected ${mode}`;
          return { status: entry.status, text: JSON.stringify({ error: msg, ...(fault.code ? { code: fault.code } : {}) }), headers: {} };
        }
      }

      const hit = routes.find((r) => r.method === method && r.regex.test(path));
      if (!hit) {
        const key = `${method} ${path}`;
        state.unhandled.set(key, (state.unhandled.get(key) || 0) + 1);
        entry.status = 501;
        entry.note = "NO MOCK HANDLER";
        return { status: 501, text: JSON.stringify({ error: `[mock] No handler for ${key}` }), headers: {} };
      }
      state.hits.set(hit.pattern, (state.hits.get(hit.pattern) || 0) + 1);

      const m = hit.regex.exec(path);
      const params = {};
      hit.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const query = Object.fromEntries(url.searchParams);
      const user = state.world.users.find((u) => u.id === state.world.sessionUserId) || null;

      if (!hit.public && !user && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/s/")) {
        entry.status = 401;
        return { status: 401, text: JSON.stringify({ error: "Sign in to continue." }), headers: {} };
      }

      let parsed = body;
      let raw = null;
      if (typeof body === "string") {
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      } else if (body instanceof FormData) {
        parsed = Object.fromEntries([...body.entries()].map(([k, v]) => [k, v]));
        raw = body;
      } else if (body != null) {
        raw = body;
        parsed = {};
      } else {
        parsed = {};
      }

      let out = await hit.handler({ world: state.world, user, params, query, body: parsed, raw, headers, method, path, url, fake: control });
      if (!(out instanceof Res)) out = new Res(200, out === undefined ? {} : out);
      entry.status = out.status;
      emit();
      return {
        status: out.status,
        text: out.body === undefined ? "" : JSON.stringify(out.body),
        headers: out.headers,
      };
    } finally {
      emit();
    }
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(rawUrl, window.location.origin).pathname;
    if (!isFake(path)) return realFetch(input, init);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const work = dispatch(method, rawUrl, init.body, init.headers || {});
    const result = await (init.signal
      ? Promise.race([
        work,
        new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true })),
      ])
      : work).catch((err) => {
      if (err instanceof NetworkError) throw new TypeError("Failed to fetch");
      throw err;
    });
    return new Response(result.status === 204 ? null : result.text, {
      status: result.status,
      headers: { "Content-Type": "application/json", ...result.headers },
    });
  };

  // ── XMLHttpRequest (uploads use it for progress) ───────────────────────────
  class FakeXHR extends EventTarget {
    constructor() {
      super();
      this.upload = new EventTarget();
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
      this.withCredentials = false;
      this._headers = {};
      this._aborted = false;
    }
    open(method, url) { this._method = method.toUpperCase(); this._url = url; this.readyState = 1; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    getResponseHeader() { return null; }
    abort() { this._aborted = true; this.onabort?.(); }
    async send(body) {
      const path = new URL(this._url, window.location.origin).pathname;
      if (!isFake(path)) { this.status = 0; this.onerror?.(); return; }
      const size = body && (body.size ?? body.byteLength ?? 0);
      const steps = 4;
      for (let i = 1; i <= steps && !this._aborted; i++) {
        await delay(120);
        const loaded = Math.round(((size || 1) * i) / steps);
        this.upload.onprogress?.({ lengthComputable: Boolean(size), loaded, total: size || 0 });
      }
      if (this._aborted) return;
      try {
        const r = await dispatch(this._method, this._url, body, this._headers);
        if (this._aborted) return;
        this.status = r.status;
        this.responseText = r.text;
        this.readyState = 4;
        this.onload?.();
      } catch {
        if (!this._aborted) this.onerror?.();
      }
    }
  }
  window.XMLHttpRequest = FakeXHR;

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
    snapshot() {
      return {
        offline: state.offline,
        latency: state.latency,
        faults: state.faults.map((f) => ({ ...f })),
        log: state.log.slice(0, 60),
        unhandled: [...state.unhandled.entries()],
        sessionUserId: state.world.sessionUserId,
      };
    },
    setOffline(v) { state.offline = Boolean(v); emit(); },
    setLatency(ms) { state.latency = Math.max(0, Number(ms) || 0); emit(); },
    addFault(rule) { state.faults = [...state.faults, { id: Math.random().toString(36).slice(2, 8), on: true, ...rule }]; emit(); },
    removeFault(id) { state.faults = state.faults.filter((f) => f.id !== id); emit(); },
    clearFaults() { state.faults = []; emit(); },
    /** Kills the session as if it expired elsewhere; the next request answers 401. */
    expireSession() { state.world.sessionUserId = null; emit(); },
    handlerPatterns() { return routes.map((r) => `${r.method} ${r.pattern}`); },
    hitCounts() { return Object.fromEntries(state.hits); },
  };
  window.__lunaFake = control;
  return control;
}

class NetworkError extends Error {}

/** Pins "now" so ages like "3 days ago" and overdue deadlines repeat exactly. */
function freezeClock(now) {
  if (!now) return;
  const RealDate = Date;
  const base = now;
  const started = RealDate.now();
  // Time still moves (timers, animations) but starts from the scenario's now.
  const current = () => base + (RealDate.now() - started);
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(current());
      else super(...args);
    }
    static now() { return current(); }
  }
  window.Date = FrozenDate;
}
