// Pure helpers for keyboard shortcuts: parse a combo string like "Alt+Shift+1",
// match it against a KeyboardEvent, and format it for display.

/**
 * @typedef {object} Combo
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {boolean} ctrl
 * @property {boolean} meta
 * @property {boolean} mod Ctrl on most systems, ⌘ on Mac.
 * @property {string} key
 */

const NAMED_KEYS = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  space: " ",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/** @param {string} combo @returns {Combo} */
export function parseCombo(combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  /** @type {Combo} */
  const out = { alt: false, shift: false, ctrl: false, meta: false, mod: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "alt") out.alt = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "ctrl") out.ctrl = true;
    else if (lower === "meta") out.meta = true;
    else if (lower === "mod") out.mod = true;
    else out.key = NAMED_KEYS[lower] || part;
  }
  return out;
}

/**
 * Physical key for a printable character. Alt (Option on Mac) changes what a
 * key types, so Alt combos are matched by position, not by the typed character.
 * @param {string} key
 */
function codeFor(key) {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key === "/") return "Slash";
  if (key === ",") return "Comma";
  if (key === ".") return "Period";
  return null;
}

/** @param {KeyboardEvent} event @param {Combo} combo */
export function matchesCombo(event, combo) {
  if (!combo.key) return false;
  if (event.altKey !== combo.alt) return false;
  if (combo.mod) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else if (event.ctrlKey !== combo.ctrl || event.metaKey !== combo.meta) {
    return false;
  }
  // "?" can only be typed with Shift held, so symbols ignore it. Letters,
  // digits, and named keys must match Shift exactly.
  const shiftIsFlexible = !combo.alt && combo.key.length === 1 && !/[a-z0-9]/i.test(combo.key);
  if (!shiftIsFlexible && event.shiftKey !== combo.shift) return false;

  const code = combo.alt ? codeFor(combo.key) : null;
  if (code) return event.code === code;
  return event.key.toLowerCase() === combo.key.toLowerCase();
}

/** True when the combo has no Alt/Ctrl/Meta: a bare key that would otherwise be typed. */
export function isBareCombo(combo) {
  return !combo.alt && !combo.ctrl && !combo.meta && !combo.mod;
}

/** Keys that also activate the focused control. */
export function isActivationKey(combo) {
  return combo.key === "Enter" || combo.key === " ";
}

/** True for fields where a bare key is text, not a shortcut. @param {EventTarget | null} target */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = /** @type {HTMLInputElement} */ (target).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "file", "color"].includes(type);
  }
  return target.getAttribute("role") === "textbox";
}

/** True for controls that Enter/Space already activate. @param {EventTarget | null} target */
export function isActivatableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (["BUTTON", "A", "SUMMARY"].includes(target.tagName)) return true;
  return ["button", "link", "menuitem", "checkbox", "switch", "tab", "option"].includes(
    target.getAttribute("role") || "",
  );
}

/** @returns {boolean} */
export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

const DISPLAY_NAMES = {
  Escape: "Esc",
  " ": "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Key caps for a combo, in the order to show them: ["Alt", "Shift", "1"].
 * @param {string} combo
 * @param {{ mac?: boolean }} [options]
 * @returns {string[]}
 */
export function comboKeycaps(combo, { mac = isMacPlatform() } = {}) {
  const parsed = parseCombo(combo);
  const caps = [];
  if (parsed.mod) caps.push(mac ? "⌘" : "Ctrl");
  if (parsed.ctrl) caps.push("Ctrl");
  if (parsed.alt) caps.push(mac ? "Option" : "Alt");
  if (parsed.shift) caps.push("Shift");
  if (parsed.meta) caps.push("⌘");
  const key = /** @type {Record<string,string>} */ (DISPLAY_NAMES)[parsed.key] || (
    parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key
  );
  caps.push(key);
  return caps;
}
