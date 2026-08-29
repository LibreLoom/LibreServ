/**
 * Validate a user-typed name for a new folder or file.
 *
 * @param {string} raw
 * @param {{ defaultExt?: string }} [opts]
 * @returns {{ name: string, error?: undefined } | { name?: undefined, error: string }}
 */
export function parseCreateName(raw, opts = {}) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { error: "Choose a name." };
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { error: "Names cannot include / or \\. Use a short name instead." };
  }
  if (trimmed === "." || trimmed === "..") {
    return { error: "Choose a different name." };
  }
  let name = trimmed;
  const defaultExt = opts.defaultExt;
  if (defaultExt && !name.includes(".")) {
    const ext = defaultExt.startsWith(".") ? defaultExt : `.${defaultExt}`;
    name = `${name}${ext}`;
  }
  if (name.length > 255) {
    return { error: "That name is too long. Use 255 characters or fewer." };
  }
  return { name };
}
