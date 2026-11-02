// @ts-nocheck -- stands in for the browser's XMLHttpRequest
// A fake XMLHttpRequest for the fake lunad. It behaves like the real one where the
// app can tell: readyState moves 1 → 2 → 3 → 4 with readystatechange, upload progress
// streams across the whole wait (latency and "slow" faults included), load / loadend /
// error / abort / timeout fire both on the on* properties and on addEventListener
// listeners, `response`, `responseText` and getResponseHeader work, and an abort in the
// middle stops the request before the fake lunad changes anything.

const STATUS_TEXT = { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error", 503: "Service Unavailable", 507: "Insufficient Storage" };

/** How long the progress bar takes to reach 100% when a request is stuck for good. */
const STALL_RAMP_MS = 1500;
/** A request that sends a body always takes at least this long, as a real upload does. */
export const MIN_UPLOAD_MS = 300;

function sizeOfBody(body) {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;
  if (typeof body.size === "number") return body.size;
  if (typeof body.byteLength === "number") return body.byteLength;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    let n = 0;
    for (const v of body.values()) n += typeof v === "string" ? v.length : v.size || 0;
    return n;
  }
  return 0;
}

function makeEvent(type, init = {}) {
  const Ctor = typeof ProgressEvent === "function" ? ProgressEvent : Event;
  const ev = new Ctor(type, init);
  if (Ctor === Event) Object.assign(ev, { lengthComputable: Boolean(init.lengthComputable), loaded: init.loaded || 0, total: init.total || 0 });
  return ev;
}

/** Fires `type` on the on<type> property and on listeners, like a real event target. */
function fire(target, type, init) {
  const ev = makeEvent(type, init);
  const handler = target[`on${type}`];
  try { if (typeof handler === "function") handler.call(target, ev); } catch (err) { reportError(err); }
  target.dispatchEvent(ev);
}
const reportError = (err) => { if (typeof globalThis.reportError === "function") globalThis.reportError(err); else setTimeout(() => { throw err; }); };

/**
 * @param {{ isFake: (path: string) => boolean, dispatch: Function }} deps
 *   dispatch(method, url, body, headers, { signal, onPlan, minWait }) → { status, text, bytes, headers }
 */
export function createXHR({ isFake, dispatch }) {
  class FakeUpload extends EventTarget {
    constructor() {
      super();
      for (const t of ["loadstart", "progress", "load", "error", "abort", "timeout", "loadend"]) this[`on${t}`] = null;
    }
  }

  class FakeXHR extends EventTarget {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;

    constructor() {
      super();
      this.UNSENT = 0; this.OPENED = 1; this.HEADERS_RECEIVED = 2; this.LOADING = 3; this.DONE = 4;
      this.upload = new FakeUpload();
      for (const t of ["readystatechange", "loadstart", "progress", "load", "error", "abort", "timeout", "loadend"]) this[`on${t}`] = null;
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = "";
      this.responseURL = "";
      this.responseType = "";
      this.timeout = 0;
      this.withCredentials = false;
      this._headers = {};
      this._resHeaders = {};
      this._sent = false;
      this._controller = null;
    }

    _setState(n) {
      this.readyState = n;
      fire(this, "readystatechange");
    }

    open(method, url) {
      this._method = String(method).toUpperCase();
      this._url = String(url);
      this._headers = {};
      this._sent = false;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = "";
      this._setState(1);
    }

    setRequestHeader(name, value) {
      if (this.readyState !== 1 || this._sent) throw new DOMException("The object is in an invalid state.", "InvalidStateError");
      this._headers[String(name).toLowerCase()] = String(value);
    }

    getResponseHeader(name) {
      if (this.readyState < 2) return null;
      return this._resHeaders[String(name).toLowerCase()] ?? null;
    }

    getAllResponseHeaders() {
      if (this.readyState < 2) return "";
      return Object.entries(this._resHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    }

    overrideMimeType() {}

    /** Ends the request the way the browser does for abort / error / timeout. */
    _fail(kind) {
      if (this._done) return;
      this._done = true;
      this._stopTicker();
      this._controller?.abort();
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = this.responseType === "json" ? null : "";
      this._setState(4);
      if (!this._uploadDone) {
        this._uploadDone = true;
        fire(this.upload, kind);
        fire(this.upload, "loadend");
      }
      fire(this, kind);
      fire(this, "loadend");
      if (kind === "abort") this.readyState = 0; // the browser resets without an event
    }

    abort() {
      if (!this._sent || this._done) {
        if (this.readyState === 1 && !this._sent) this.readyState = 0;
        return;
      }
      this._fail("abort");
    }

    _stopTicker() {
      clearInterval(this._ticker);
      clearTimeout(this._timeoutTimer);
    }

    _progressTo(loaded, total) {
      const init = { lengthComputable: total > 0, loaded, total };
      fire(this.upload, "progress", init);
    }

    send(body = null) {
      if (this.readyState !== 1 || this._sent) throw new DOMException("The object is in an invalid state.", "InvalidStateError");
      this._sent = true;
      this._done = false;
      this._uploadDone = false;
      const total = sizeOfBody(body);
      fire(this, "loadstart");
      fire(this.upload, "loadstart");
      if (!isFake(new URL(this._url, window.location.origin).pathname)) {
        // Not Luna's API: nothing out there answers.
        setTimeout(() => this._fail("error"), 0);
        return;
      }
      if (this.timeout > 0) this._timeoutTimer = setTimeout(() => this._fail("timeout"), this.timeout);
      this._controller = new AbortController();

      // The progress bar follows the real wait the fake lunad announces.
      const startedAt = performance.now();
      let rampMs = MIN_UPLOAD_MS;
      this._progressTo(0, total);
      this._ticker = setInterval(() => {
        if (this._done || this._uploadDone) return;
        const f = Math.min(1, (performance.now() - startedAt) / rampMs);
        this._progressTo(Math.min(total, Math.round(total * f)), total);
        if (f >= 1) clearInterval(this._ticker);
      }, 100);

      dispatch(this._method, this._url, body, this._headers, {
        signal: this._controller.signal,
        minWait: total > 0 ? MIN_UPLOAD_MS : 0,
        onPlan: ({ waitMs }) => { rampMs = Number.isFinite(waitMs) ? Math.max(waitMs, MIN_UPLOAD_MS) : STALL_RAMP_MS; },
      }).then((r) => {
        if (this._done) return;
        clearInterval(this._ticker);
        // The whole body has gone out.
        this._progressTo(total, total);
        this._uploadDone = true;
        fire(this.upload, "load", { lengthComputable: total > 0, loaded: total, total });
        fire(this.upload, "loadend", { lengthComputable: total > 0, loaded: total, total });
        this.status = r.status;
        this.statusText = STATUS_TEXT[r.status] || "";
        this.responseURL = new URL(this._url, window.location.origin).href;
        const type = r.headers?.["Content-Type"] || "application/json";
        this._resHeaders = { "content-type": type, ...Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])) };
        this._setState(2);
        if (this._done) return;
        this._setState(3);
        if (this._done) return;
        const text = r.bytes == null ? r.text : "";
        this.responseText = text;
        const len = text.length;
        fire(this, "progress", { lengthComputable: true, loaded: len, total: len });
        if (this._done) return;
        this._done = true;
        this._stopTicker();
        this.response = this._responseValue(r, text);
        this._setState(4);
        fire(this, "load", { lengthComputable: true, loaded: len, total: len });
        fire(this, "loadend", { lengthComputable: true, loaded: len, total: len });
      }, (err) => {
        if (this._done) return;
        if (err?.name === "AbortError") return;
        this._fail("error");
      });
    }

    _responseValue(r, text) {
      switch (this.responseType) {
        case "json": try { return JSON.parse(text); } catch { return null; }
        case "blob": return new Blob([r.bytes ?? text]);
        case "arraybuffer": return new TextEncoder().encode(text).buffer;
        default: return text;
      }
    }
  }
  return FakeXHR;
}
