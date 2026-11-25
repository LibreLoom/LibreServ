/**
 * The shape of a refused delete when the folder holds private items. Luna names
 * the owners only to an Admin and the items only to their own owner; anyone
 * else gets the plain refusal.
 * @param {unknown} err A failed request.
 * @returns {{ owners?: string[], items?: string[], message: string } | null}
 */
export function holdsPrivateOf(err) {
  const e = /** @type {any} */ (err);
  if (e?.code !== "holds_private") return null;
  const list = (/** @type {unknown} */ v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  const owners = list(e.data?.owners);
  const items = list(e.data?.items);
  return {
    ...(owners.length ? { owners } : {}),
    ...(items.length ? { items } : {}),
    message: String(e.message || ""),
  };
}

