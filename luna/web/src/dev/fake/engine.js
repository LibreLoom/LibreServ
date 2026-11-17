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
 * What a request was trying to do, in words a person would use. Used only when
 * a fault carries no message of its own, so the gallery never shows "Luna
 * couldn't do that" — that names nothing and tells nobody what to retry.
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
function faultMessage(method, path) {
  const says = (s) => s;
  // Deleting is its own action whatever it is aimed at: a failed DELETE for
  // people, photos or uploads is not a failed *load* of them.
  if (method === "DELETE") {
    if (/\/access\/links/.test(path)) return says("turn this link off");
    if (/\/access\/members/.test(path)) return says("remove that person");
    if (/\/device-tokens/.test(path)) return says("revoke that access token");
    // Taking a photo out of Favorites or an album does not delete the photo,
    // so a failure there must not say it does.
    if (/\/gallery\/favorites/.test(path)) return says("take that photo out of Favorites");
    if (/\/gallery\/albums\/[^/]+\/[^/]+\/items/.test(path)) return says("take that photo out of the album");
    return says("delete that");
  }
  if (/\/device-tokens/.test(path)) return says("load your apps and access tokens");
  if (/\/users/.test(path)) return says("load the people on this Luna");
  if (/\/gallery\/places/.test(path)) return says("load where your photos were taken");
  if (/\/gallery\//.test(path)) return says("load your photos");
  // A drive request is only a read when it is a read: an upload or a rename is
  // a write, and calling that "read this drive" names the wrong action.
  const reading = method === "GET" || method === "HEAD";
  if (/\/uploads?\b/.test(path)) return says(reading ? "load that upload" : "upload that file");
  if (/\/drives\//.test(path)) {
    if (reading) return says("read this drive");
    if (/\/rename/.test(path)) return says("rename that");
    if (/\/mkdir/.test(path)) return says("make that folder");
    if (/\/delete/.test(path)) return says("delete that");
    return says("save that change");
  }
  if (/\/drives$/.test(path)) return says("load your drives");
  if (/\/connect\/status|\/network\/status/.test(path)) return says("check how Luna is connected");
  if (/\/system\/updates\/source/.test(path)) return says("change where updates come from");
  if (/\/system\/updates\/apply/.test(path)) return says("install this update");
  if (/\/system\/updates/.test(path)) return says("check for updates");
  if (/\/system\/factory-reset/.test(path)) return says("reset this Luna");
  if (/\/access\/members/.test(path)) return says("change who can reach this");
  if (/\/access\/links/.test(path)) return says("change this link");
  if (/\/access\//.test(path)) return says("load who can reach this");
  if (/\/stat$|\/file$|\/tree$/.test(path)) return says("open this shared item");
  if (method === "DELETE") return says("delete that");
  if (method === "GET" || method === "HEAD") return says("load that");
  return says("save that");
}

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

  // A second installation must reach the browser's own fetch, not the previous
  // installation's wrapper, or every install would keep the world before it
  // alive through one more closure. Same rule as the `src` setter below.
  const nativeFetch = window.fetch?.__mockNative ?? window.fetch;
  const realFetch = nativeFetch?.bind(window);
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
        // A fault with no message of its own still has to read like Luna, and
        // name the thing that failed. Most pages show their own inline error
        // and never display this.
        const what = faultMessage(method, path);
        const plain = mode.startsWith("5")
          ? `Luna couldn't ${what} just now. Try again in a moment.`
          : `Luna couldn't ${what}.`;
        return finish(Number(mode), JSON.stringify({ error: fault.message || plain, ...(fault.code ? { code: fault.code } : {}) }));
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
  window.fetch.__mockNative = nativeFetch;

  window.XMLHttpRequest = createXHR({ isFake, dispatch });

  // ── Media elements ─────────────────────────────────────────────────────────
  // An <img src>, <video src>, <audio src> or <iframe src> is loaded by the
  // browser itself, not by fetch or XHR, so it would reach the real dev server
  // and 404. Rewrite any /api address to a blob URL built from the fake's
  // answer, so photos, videos and PDF frames show in the gallery.
  const MEDIA = [window.HTMLImageElement, window.HTMLMediaElement, window.HTMLSourceElement, window.HTMLIFrameElement];
  const blobs = new Map();
  const realSetters = new WeakMap();
  // What each element was last asked to show. A reply that arrives after the
  // element moved on (or lost its src) must not put the old picture back.
  const wanted = new WeakMap();
  // The one object URL an element is showing right now. Each element makes its
  // own URL from a body shared by everyone who asked for the same href, so a
  // superseded element releases exactly its own URL and never the URL another
  // element is about to render.
  const shown = new WeakMap();
  const showUrl = (el, url) => {
    const previous = shown.get(el);
    if (previous && previous !== url) URL.revokeObjectURL(previous);
    shown.set(el, url);
    realSetters.get(el)?.call(el, url);
  };
  const dropUrl = (el) => {
    const previous = shown.get(el);
    if (!previous) return;
    shown.delete(el);
    URL.revokeObjectURL(previous);
  };
  // Bumped per installation so a callback from a replaced world can tell it is
  // stale, even when the element and href it remembers still look current.
  window.__mockGeneration = (window.__mockGeneration || 0) + 1;
  const generation = window.__mockGeneration;

  const swapSrc = (el, url) => {
    const href = typeof url === "string" ? url : String(url?.href ?? url ?? "");
    // Whatever the element is asked for now, a reply already in flight is no
    // longer wanted — including for a real or external address the fake leaves
    // alone, and for an empty value that clears the picture.
    wanted.set(el, href);
    let parsed;
    try { parsed = new URL(href, window.location.origin); } catch { return null; }
    if (parsed.origin !== window.location.origin || !isFake(parsed.pathname)) {
      // The element now shows something the fake does not own, so the picture it
      // was showing is finished with.
      dropUrl(el);
      return null;
    }
    if (!blobs.has(href)) {
      const request = (async () => {
        const result = await dispatch("GET", href, undefined, {}, {});
        if (result.status >= 400) throw new Error(`[mock] ${result.status} ${href}`);
        return new Blob([result.bytes ?? result.text], { type: result.headers?.["Content-Type"] || "application/octet-stream" });
      })();
      blobs.set(href, request);
      // Dedupe only what is in flight. Keeping a finished request would answer
      // later loads from it, so a fault added afterwards would never run and a
      // failure review would see the photo succeed. lunad serves these with
      // `no-store`, so every load is a real request.
      const settle = () => blobs.delete(href);
      request.then(settle, settle);
    }
    // A reply that arrives after the harness moved on to another world must
    // not paint: the newer installation owns the element now, and its own
    // `wanted` has already said what belongs there.
    const mine = generation;
    blobs.get(href)
      .then((body) => {
        // Two ways a finished reply is not used: the world was replaced, or the
        // element asked for something else. Nothing was allocated yet, so there
        // is nothing to release — the element still shows what it showed.
        if (mine !== window.__mockGeneration) return;
        if (wanted.get(el) !== href) return;
        showUrl(el, URL.createObjectURL(body));
      })
      .catch(() => {
        if (mine !== window.__mockGeneration) return;
        if (wanted.get(el) !== href) return;
        el.dispatchEvent(new Event("error"));
      });
    return true;
  };
  for (const Ctor of MEDIA) {
    if (!Ctor) continue;
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "src");
    if (!desc?.set) continue;
    // Kept once and rewrapped on every install, for the same reason as
    // setAttribute below: reading `desc.set` on a second installation would
    // pick up the previous wrapper and its closed-over dispatcher.
    const realSet = desc.set.__mockNative ?? desc.set;
    const setSrc = function (value) {
      realSetters.set(this, realSet);
      if (swapSrc(this, value)) return;
      realSet.call(this, value);
    };
    setSrc.__mockNative = realSet;
    Object.defineProperty(Ctor.prototype, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: setSrc,
    });
    // The native methods are kept once and the wrapper replaced on every
    // installation: a wrapper closes over this installation's dispatcher and
    // fault rules, so reusing the first one would keep answering from a world
    // the harness has already replaced.
    const realAttr = Ctor.prototype.setAttribute?.__mockNative ?? Ctor.prototype.setAttribute;
    if (realAttr) {
      const patched = function (name, value) {
        if (String(name).toLowerCase() === "src" && this.src !== undefined) {
          realSetters.set(this, realSet);
          // Removing the attribute cancels whatever was still on its way.
          if (value === null || value === undefined || value === "") wanted.set(this, "");
          if (swapSrc(this, value)) return;
        }
        return realAttr.call(this, name, value);
      };
      patched.__mockPatched = true;
      patched.__mockNative = realAttr;
      Ctor.prototype.setAttribute = patched;
    }
    const realRemove = Ctor.prototype.removeAttribute?.__mockNative ?? Ctor.prototype.removeAttribute;
    if (realRemove) {
      const patched = function (name) {
        // Taking the attribute off cancels a reply still on its way, so a
        // removed picture cannot reappear on its own.
        if (String(name).toLowerCase() === "src" && this.src !== undefined) wanted.set(this, "");
        return realRemove.call(this, name);
      };
      patched.__mockPatched = true;
      patched.__mockNative = realRemove;
      Ctor.prototype.removeAttribute = patched;
    }
  }

  // ── WebSocket: live co-editing needs the real daemon ───────────────────────
  // A Download is a plain `<a download>`: the browser navigates, so neither the
  // fetch patch nor the media patch sees it, and the dev server proxies `/s/`
  // to the real lunad — which does not know these tokens. Catch the click and
  // hand over the fake's own bytes instead.
  //
  // Two shapes: the `download` attribute, or the link a share page builds with
  // `?download=1` and no attribute.
  const fakeDownloadUrl = (link) => {
    let parsed;
    try { parsed = new URL(link.href, window.location.origin); } catch { return null; }
    if (parsed.origin !== window.location.origin || !isFake(parsed.pathname)) return null;
    // Three shapes: the `download` attribute, the `?download=1` link a share
    // page builds, and a public link's `/s/:token/zip`, which is a download
    // even though it carries neither.
    const isDownload =
      link.hasAttribute("download") ||
      parsed.searchParams.get("download") === "1" ||
      /^\/s\/[^/]+\/zip\/?$/.test(parsed.pathname);
    return isDownload ? parsed : null;
  };
  const onDownloadClick = (event) => {
    const link = event.target?.closest?.("a");
    if (!link) return;
    const parsed = fakeDownloadUrl(link);
    if (!parsed) return;
    event.preventDefault();
    serveDownload(link, parsed);
  };
  // A detached anchor never reaches `document`, and the Files list builds one
  // for its `d` shortcut; the phone action sheet navigates from a button. Both
  // are real navigation, so both are caught here rather than in the app.
  const realAnchorClick = HTMLAnchorElement.prototype.click;
  if (realAnchorClick) {
    // Unwrap to the browser's own click, not the previous installation's
    // wrapper: that one closes over a dispatcher for a world already replaced,
    // and chaining would keep every earlier world alive.
    const nativeClick = realAnchorClick.__mockNative ?? realAnchorClick;
    const patchedClick = function () {
      const parsed = fakeDownloadUrl(this);
      if (parsed) return serveDownload(this, parsed);
      return nativeClick.call(this);
    };
    patchedClick.__mockNative = nativeClick;
    HTMLAnchorElement.prototype.click = patchedClick;
  }
  const serveDownload = (link, parsed) => {
    dispatch("GET", link.href, undefined, {}, {})
      .then((result) => {
        if (result.status >= 400) throw new Error(`[mock] ${result.status} ${link.href}`);
        const url = URL.createObjectURL(new Blob([result.bytes ?? result.text], { type: result.headers?.["Content-Type"] || "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        // The answer already names the file; the URL does not (a drive
        // download ends in `/content`). Prefer what the fake said.
        const said = /filename="([^"]+)"/.exec(result.headers?.["Content-Disposition"] || "")?.[1];
        a.download = link.getAttribute("download") || said || parsed.pathname.split("/").pop() || "download";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch(() => link.dispatchEvent(new Event("error")));
  };
  // One listener however many times the harness reinstalls; the handler reads
  // the current dispatch and isFake through its closure on this installation.
  // `auxclick` too: middle-clicking a Download opens it in a new tab otherwise,
  // which the dev server proxies to a real lunad that has never heard of it.
  const onAuxClick = (event) => {
    if (event.button === 1) onDownloadClick(event);
  };
  if (window.__mockDownloadClick) {
    document.removeEventListener("click", window.__mockDownloadClick, true);
    document.removeEventListener("auxclick", window.__mockAuxClick, true);
  }
  window.__mockDownloadClick = onDownloadClick;
  window.__mockAuxClick = onAuxClick;
  document.addEventListener("click", onDownloadClick, true);
  document.addEventListener("auxclick", onAuxClick, true);

  const RealWS = window.WebSocket?.__mockNative ?? window.WebSocket;
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
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, __mockNative: RealWS });
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
