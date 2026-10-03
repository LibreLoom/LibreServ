import { useSyncExternalStore } from "react";

const STORAGE_KEY = "luna-tips";
const SESSION_KEY = "luna-tip-session";
const CHANGE_EVENT = "luna:tips-changed";
/** A new visit shows a tip only if the last one was at least this long ago. */
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

/**
 * Every tip must teach something a person can use right now, in about 30
 * characters so the pill stays on one line on a phone. `when` hides a
 * tip on devices where it can't apply (a keyboard tip on a phone).
 *
 * @typedef {{ id: string, text: string, when?: () => boolean }} Tip
 * @type {Tip[]}
 */
export const TIPS = [
  {
    id: "keyboard-shortcuts",
    text: "Press ? for shortcuts",
    when: hasMouse,
  },
  {
    id: "drag-to-upload",
    text: "Drag in files to upload them",
    when: hasMouse,
  },
  {
    id: "drag-to-move",
    text: "Drag files to folders to move",
    when: hasMouse,
  },
  {
    id: "share-link",
    text: "Share links can have a password",
  },
  {
    id: "photo-albums",
    text: "Select photos, add to an album",
  },
  {
    id: "photo-favorites",
    text: "Favorite a photo to revisit it",
  },
  {
    id: "photo-places",
    text: "See photos on a map in Places",
  },
  {
    id: "whiteboard",
    text: "Sketch ideas: New → Whiteboard",
  },
  {
    id: "custom-colors",
    text: "Change colors in Settings",
  },
  {
    id: "touch-select-photos",
    text: "Hold a photo to select several",
    when: hasTouch,
  },
];

function matches(query) {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** A mouse or trackpad, so keyboards and dragging are in play. */
function hasMouse() {
  return matches("(hover: hover) and (pointer: fine)");
}

function hasTouch() {
  return matches("(pointer: coarse)");
}

/** @typedef {{ enabled: boolean, dismissed: string[], seen: string[], lastShown: number }} TipState */

/** @type {TipState} */
const DEFAULTS = { enabled: true, dismissed: [], seen: [], lastShown: 0 };

let cachedRaw = null;
let cachedState = DEFAULTS;

/** @returns {TipState} */
export function readTipState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — fall back to defaults */
  }
  if (raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    cachedState = {
      enabled: parsed.enabled !== false,
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      lastShown: Number(parsed.lastShown) || 0,
    };
  } catch {
    cachedState = DEFAULTS;
  }
  return cachedState;
}

/** @param {Partial<TipState>} patch */
function writeTipState(patch) {
  const next = { ...readTipState(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the change still applies for this page view */
    cachedRaw = null;
    cachedState = next;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setTipsEnabled(enabled) {
  writeTipState({ enabled: Boolean(enabled) });
}

export function dismissTip(id) {
  const { dismissed } = readTipState();
  if (!dismissed.includes(id)) writeTipState({ dismissed: [...dismissed, id] });
}

export function restoreDismissedTips() {
  writeTipState({ dismissed: [] });
}

function subscribe(callback) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useTipState() {
  return useSyncExternalStore(subscribe, readTipState, () => DEFAULTS);
}

/**
 * The tip for this browser session, or null. Decided once per session so a
 * reload keeps the same tip, and a new visit only shows one about once a day.
 * Prefers tips not shown yet; once all have been shown, starts over.
 *
 * @param {number} [now]
 * @returns {Tip | null}
 */
export function tipForSession(now = Date.now()) {
  const state = readTipState();
  if (!state.enabled) return null;

  let remembered = null;
  try {
    remembered = sessionStorage.getItem(SESSION_KEY);
  } catch {
    /* no session storage — decide again on every load */
  }
  if (remembered !== null) return TIPS.find((t) => t.id === remembered) ?? null;

  const pool = TIPS.filter((t) => !state.dismissed.includes(t.id) && (t.when?.() ?? true));
  const fresh = pool.filter((t) => !state.seen.includes(t.id));
  const tip = pool.length === 0 || now - state.lastShown < MIN_GAP_MS ? null : (fresh[0] ?? pool[0]);

  try {
    sessionStorage.setItem(SESSION_KEY, tip ? tip.id : "");
  } catch {
    /* see above */
  }
  if (tip) {
    const seen = fresh.length ? [...state.seen, tip.id] : [tip.id];
    writeTipState({ seen, lastShown: now });
  }
  return tip;
}
