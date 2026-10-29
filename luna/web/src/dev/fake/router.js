// The route table of the fake lunad, and the helpers handlers answer with.
//
// A route is METHOD + pattern ("/api/v1/drives/:id/summary"). Registering the same
// method and pattern twice throws (parameter names don't count: ":id" and ":name"
// are the same slot), and a static segment beats a parameter, so the order handler
// files are imported in never matters.

/** A non-200 or custom-header answer. Plain return values mean 200 JSON. */
export class Res {
  /** @type {string | Uint8Array | Blob | ReadableStream<Uint8Array> | undefined} file or event-stream body, set by raw() */
  bytes = undefined;

  /** @param {number} status @param {any} body @param {Record<string, string>} [headers] */
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
/** A non-JSON answer (file contents or a streamed response body). */
export const raw = (bytes, type = "application/octet-stream", status = 200, headers = {}) => {
  const res = new Res(status, undefined, { "Content-Type": type, ...headers });
  res.bytes = bytes;
  return res;
};

const segmentsOf = (pattern) => pattern.split("/");
/** "GET /a/:x/b" and "GET /a/:y/b" are the same slot. */
const signatureOf = (method, pattern) => `${method} ${segmentsOf(pattern).map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`;

/** A route table. The global one below is what handler files register into. */
export function createRouter() {
  /** @type {Array<{method:string, pattern:string, regex:RegExp, keys:string[], handler:Function, public:boolean, segs:string[]}>} */
  const routes = [];
  const signatures = new Set();

  function route(method, pattern, handler, opts = {}) {
    const sig = signatureOf(method, pattern);
    if (signatures.has(sig)) throw new Error(`Duplicate fake route: ${method} ${pattern}`);
    signatures.add(sig);
    const keys = [];
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; });
    routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, public: Boolean(opts.public), segs: segmentsOf(pattern) });
    // Most specific first: at the first segment where two patterns differ, static wins.
    routes.sort((a, b) => {
      const n = Math.max(a.segs.length, b.segs.length);
      for (let i = 0; i < n; i += 1) {
        const pa = a.segs[i]?.startsWith(":") ? 1 : 0;
        const pb = b.segs[i]?.startsWith(":") ? 1 : 0;
        if (pa !== pb) return pa - pb;
      }
      return 0;
    });
  }

  /** The best route for a request, with its :params decoded. */
  function find(method, path) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  return { route, find, patterns: () => routes.map((r) => ({ method: r.method, pattern: r.pattern })) };
}

const registry = createRouter();

/** Register a handler. `pattern` uses :params, e.g. "/api/v1/drives/:id/summary". */
export const route = registry.route;
export const findRoute = registry.find;
/** Every registered "METHOD /pattern", without installing the fake. */
export const handlerPatterns = () => registry.patterns();

export const get = (p, h, o) => route("GET", p, h, o);
export const post = (p, h, o) => route("POST", p, h, o);
export const put = (p, h, o) => route("PUT", p, h, o);
export const patch = (p, h, o) => route("PATCH", p, h, o);
export const del = (p, h, o) => route("DELETE", p, h, o);
