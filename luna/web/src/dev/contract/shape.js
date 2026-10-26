// Response shapes: what a JSON answer looks like without its values. lunad's API tests record
// them (crates/lunad/src/api/contract.rs); the contract test builds the same kind of shape from
// the fake and compares the two. Pure functions, no DOM.

/**
 * @typedef {{
 *   leaves: Set<string>,
 *   object: Map<string, { shape: Shape, optional: boolean }> | null,
 *   array: { elem: Shape | null } | null,
 * }} Shape
 * @typedef {{ path: string, message: string }} Mismatch
 */

/** @returns {Shape} */
const empty = () => ({ leaves: new Set(), object: null, array: null });

/**
 * The shape of one JSON value.
 * @param {unknown} value
 * @returns {Shape}
 */
export function shapeOf(value) {
  const s = empty();
  if (value === null || value === undefined) s.leaves.add("null");
  else if (typeof value === "boolean") s.leaves.add("boolean");
  else if (typeof value === "number") s.leaves.add("number");
  else if (typeof value === "string") s.leaves.add("string");
  else if (Array.isArray(value)) {
    /** @type {Shape | null} */
    let elem = null;
    for (const item of value) elem = elem ? mergeShapes(elem, shapeOf(item)) : shapeOf(item);
    s.array = { elem };
  } else if (typeof value === "object") {
    s.object = new Map();
    for (const [k, v] of Object.entries(value)) s.object.set(k, { shape: shapeOf(v), optional: false });
  } else s.leaves.add("string");
  return s;
}

/**
 * Merges two shapes into a new one. The result does not depend on the order or grouping.
 * @param {Shape} a
 * @param {Shape} b
 * @returns {Shape}
 */
export function mergeShapes(a, b) {
  const out = empty();
  for (const l of a.leaves) out.leaves.add(l);
  for (const l of b.leaves) out.leaves.add(l);
  if (a.object && b.object) {
    out.object = new Map();
    for (const k of new Set([...a.object.keys(), ...b.object.keys()])) {
      const x = a.object.get(k);
      const y = b.object.get(k);
      if (x && y) out.object.set(k, { shape: mergeShapes(x.shape, y.shape), optional: x.optional || y.optional });
      else out.object.set(k, { shape: /** @type {any} */ (x || y).shape, optional: true });
    }
  } else if (a.object || b.object) {
    out.object = new Map(/** @type {any} */ (a.object || b.object));
  }
  if (a.array && b.array) {
    out.array = { elem: a.array.elem && b.array.elem ? mergeShapes(a.array.elem, b.array.elem) : a.array.elem || b.array.elem };
  } else if (a.array || b.array) {
    out.array = { elem: /** @type {any} */ (a.array || b.array).elem };
  }
  return out;
}

/**
 * Reads a shape in the fixture's JSON form.
 * @param {any} json
 * @returns {Shape}
 */
export function parseFixtureShape(json) {
  const s = empty();
  if (typeof json === "string") {
    for (const l of json.split("|")) if (l) s.leaves.add(l);
    return s;
  }
  if (Array.isArray(json)) {
    s.array = { elem: json.length ? parseFixtureShape(json[0]) : null };
    return s;
  }
  if (json && typeof json === "object") {
    if (Array.isArray(json.$oneOf)) {
      return json.$oneOf.reduce((acc, part) => mergeShapes(acc, parseFixtureShape(part)), empty());
    }
    s.object = new Map();
    for (const [key, value] of Object.entries(json)) {
      const optional = key.endsWith("?");
      s.object.set(optional ? key.slice(0, -1) : key, { shape: parseFixtureShape(value), optional });
    }
  }
  return s;
}

/**
 * The fixture's JSON form of a shape (used in messages).
 * @param {Shape} shape
 * @returns {any}
 */
export function toFixtureJson(shape) {
  /** @type {any[]} */
  const parts = [];
  if (shape.leaves.size) parts.push([...shape.leaves].sort().join("|"));
  if (shape.object) {
    /** @type {Record<string, any>} */
    const o = {};
    for (const k of [...shape.object.keys()].sort()) {
      const { shape: child, optional } = /** @type {any} */ (shape.object.get(k));
      o[optional ? `${k}?` : k] = toFixtureJson(child);
    }
    parts.push(o);
  }
  if (shape.array) parts.push(shape.array.elem ? [toFixtureJson(shape.array.elem)] : []);
  if (parts.length === 0) return "null";
  return parts.length === 1 ? parts[0] : { $oneOf: parts };
}

/**
 * "GET /api/v1/drives/:id/files" and "GET /api/v1/drives/{drive_id}/files" give the same key.
 * @param {string} method
 * @param {string} path
 */
export function normalizeKey(method, path) {
  const p = path
    .replace(/\{\*[^}]*\}/g, "{*}")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}");
  return `${method.toUpperCase()} ${p}`;
}

const describe = (shape) => {
  const text = JSON.stringify(toFixtureJson(shape));
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/**
 * Compares lunad's shape with the fake's. Paths read `$`, `$.key`, `$[]`.
 * `weak` lists the places that could not be checked (lunad only ever sent null or an empty list).
 * @param {Shape} real
 * @param {Shape} fake
 * @param {string} [path]
 * @returns {{ errors: Mismatch[], weak: string[] }}
 */
export function compareShapes(real, fake, path = "$") {
  /** @type {Mismatch[]} */
  const errors = [];
  /** @type {string[]} */
  const weak = [];
  const onlyNull = real.leaves.size === 1 && real.leaves.has("null") && !real.object && !real.array;
  if (onlyNull) return { errors, weak: [path] };

  for (const t of fake.leaves) {
    if (!real.leaves.has(t)) errors.push({ path, message: `fake sends ${t}, lunad sends ${describe(real)}` });
  }
  if (fake.object && !real.object) errors.push({ path, message: `type mismatch: fake sends an object, lunad sends ${describe(real)}` });
  if (fake.array && !real.array) errors.push({ path, message: `type mismatch: fake sends a list, lunad sends ${describe(real)}` });

  if (fake.object && real.object) {
    for (const [k, f] of fake.object) {
      const r = real.object.get(k);
      if (!r) {
        errors.push({ path: `${path}.${k}`, message: `extra key \`${k}\` (lunad never sends it)` });
        continue;
      }
      if (f.optional && !r.optional) errors.push({ path: `${path}.${k}`, message: `\`${k}\` missing from some fake answers` });
      const sub = compareShapes(r.shape, f.shape, `${path}.${k}`);
      errors.push(...sub.errors);
      weak.push(...sub.weak);
    }
    for (const [k, r] of real.object) {
      if (!fake.object.has(k) && !r.optional) errors.push({ path: `${path}.${k}`, message: `missing key \`${k}\`` });
    }
  }

  if (fake.array && real.array) {
    if (!fake.array.elem || !real.array.elem) weak.push(`${path}[]`);
    else {
      const sub = compareShapes(real.array.elem, fake.array.elem, `${path}[]`);
      errors.push(...sub.errors);
      weak.push(...sub.weak);
    }
  }
  return { errors, weak };
}
