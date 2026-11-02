// How a "Break things" rule decides which request it catches.
//
//   "GET /api/v1/drives"            exactly that path (trailing slash ignored)
//   "/api/v1/drives"                same path, any method
//   "GET /api/v1/drives/*/files"    * is a wildcard: any characters, slashes included
//   "GET /api/v1/gallery?kind=video" the request must also carry these query pairs
//
// Nothing is a substring match: "GET /api/v1/drives" never catches /drives/d1/files.

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Splits a rule into its method, path pattern and required query pairs. */
export function parseRule(match) {
  const text = String(match || "").trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  const hasMethod = parts.length > 1 && /^[A-Za-z]+$/.test(parts[0]);
  const method = hasMethod ? parts[0].toUpperCase() : null;
  const target = (hasMethod ? parts.slice(1) : parts).join(" ");
  const cut = target.indexOf("?");
  const pathPart = cut === -1 ? target : target.slice(0, cut);
  const query = cut === -1 ? {} : Object.fromEntries(new URLSearchParams(target.slice(cut + 1)));
  const path = pathPart.length > 1 ? pathPart.replace(/\/+$/, "") : pathPart;
  const re = new RegExp(`^${path.split("*").map(escapeRe).join(".*")}$`);
  return { method, path, query, re };
}

/** Does `rule.match` catch this request? `search` is the URL's query string. */
export function ruleMatches(rule, method, path, search = "") {
  const parsed = rule._parsed ?? parseRule(rule.match);
  if (!parsed) return false;
  if (parsed.method && parsed.method !== method) return false;
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (!parsed.re.test(clean)) return false;
  const wanted = Object.entries(parsed.query);
  if (!wanted.length) return true;
  const have = new URLSearchParams(search);
  return wanted.every(([k, v]) => have.get(k) === v);
}
