/* eslint-disable react-refresh/only-export-components -- re-exports the paired hooks */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "../components/cards/ModalCard.jsx";
import {
  comboKeycaps,
  isActivatableTarget,
  isActivationKey,
  isBareCombo,
  isEditableTarget,
  matchesCombo,
} from "../lib/shortcuts.js";
import { ShortcutsContext, useShortcut } from "./shortcutsRegistry.js";

export { useShortcut, useShortcutsSheet } from "./shortcutsRegistry.js";

/** @typedef {import("./shortcutsRegistry.js").Registration} Registration */

const GROUP_ORDER = ["Search", "Go to", "Files", "Photos", "Settings", "General"];

let nextId = 0;

/** A visible modal dialog is up. Always-mounted but hidden ones (mobile menus) don't count. */
function isDialogOpen() {
  return [...document.querySelectorAll('[aria-modal="true"]')].some(
    (el) => typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true }),
  );
}

/** Every entry the sheet shows: one row per shortcut, only for keys it actually wins. */
function sheetGroups(/** @type {Registration[]} */ registrations) {
  /** @type {Map<string, Registration>} */
  const winners = new Map();
  for (const reg of registrations) {
    for (const key of reg.keys) {
      const current = winners.get(key);
      if (!current || reg.priority > current.priority || (reg.priority === current.priority && reg.id > current.id)) {
        winners.set(key, reg);
      }
    }
  }
  /** @type {Map<string, { label: string, keys: string[] }[]>} */
  const groups = new Map();
  for (const reg of registrations) {
    if (reg.hidden) continue;
    const keys = reg.keys.filter((key) => winners.get(key) === reg);
    if (keys.length === 0) continue;
    const rows = groups.get(reg.group) || [];
    const same = rows.find((row) => row.label === reg.label);
    if (same) same.keys.push(...keys.filter((k) => !same.keys.includes(k)));
    else rows.push({ label: reg.label, keys });
    groups.set(reg.group, rows);
  }
  const rank = (/** @type {string} */ name) => {
    const i = GROUP_ORDER.indexOf(name);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

function Keycaps({ combo }) {
  return (
    <span className="inline-flex items-center gap-1">
      {comboKeycaps(combo).map((cap) => (
        <kbd key={cap} className="font-mono text-xs rounded-pill surface-primary px-2 py-0.5">
          {cap}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutsSheet({ open, onClose, registrations }) {
  const groups = useMemo(() => sheetGroups(registrations), [registrations]);
  return (
    <ModalCard title="Keyboard shortcuts" open={open} onClose={onClose} size="md" openHaptic="light" overlayClassName={NESTED_OVERLAY_CLASS}>
      <div className="space-y-5">
        {groups.map(([group, rows]) => (
          <section key={group} aria-label={group}>
            <h3 className="font-mono text-xs mb-2">{group}</h3>
            <ul className="space-y-1.5">
              {rows.map((row) => (
                <li key={row.label} className="flex items-center justify-between gap-4 text-sm text-primary">
                  <span>{row.label}</span>
                  <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                    {row.keys.map((combo, i) => (
                      <span key={combo} className="inline-flex items-center gap-2">
                        {i > 0 && <span className="text-xs">or</span>}
                        <Keycaps combo={combo} />
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ModalCard>
  );
}

/** One listener for the whole app; pages and controls register through `useShortcut`. */
export function ShortcutsProvider({ children }) {
  const registry = useRef(/** @type {Map<number, Registration>} */ (new Map()));
  const [version, setVersion] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  const register = useCallback((/** @type {Omit<Registration, "id">} */ reg) => {
    const id = ++nextId;
    registry.current.set(id, { ...reg, id });
    setVersion((v) => v + 1);
    return () => {
      registry.current.delete(id);
      setVersion((v) => v + 1);
    };
  }, []);

  const list = useCallback(() => [...registry.current.values()], []);
  const openSheet = useCallback(() => setSheetOpen(true), []);

  useEffect(() => {
    function onKeyDown(/** @type {KeyboardEvent} */ event) {
      if (event.defaultPrevented || event.isComposing) return;
      const dialogOpen = isDialogOpen();
      const typing = isEditableTarget(event.target);

      const candidates = [];
      for (const reg of registry.current.values()) {
        if (!reg.enabled) continue;
        if (event.repeat && !reg.repeat) continue;
        if (dialogOpen && !reg.allowInModal) continue;
        const combo = reg.combos.find((c) => matchesCombo(event, c));
        if (!combo) continue;
        if (typing && !(reg.allowInInput ?? combo.alt)) continue;
        if (isBareCombo(combo) && isActivationKey(combo) && isActivatableTarget(event.target)) continue;
        candidates.push(reg);
      }
      candidates.sort((a, b) => b.priority - a.priority || b.id - a.id);

      for (const reg of candidates) {
        if (reg.handlerRef.current(event) === false) continue;
        event.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ register, list, openSheet }), [register, list, openSheet]);

  // The sheet reads the registry when it opens and whenever registrations change.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the change signal
  const registrations = useMemo(() => (sheetOpen ? list() : []), [sheetOpen, list, version]);

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      <SheetShortcut onOpen={openSheet} />
      <ShortcutsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} registrations={registrations} />
    </ShortcutsContext.Provider>
  );
}

function SheetShortcut({ onOpen }) {
  // Allowed over dialogs (the photo viewer is one); the sheet raises itself above them.
  useShortcut("?", onOpen, { label: "Show this list of shortcuts", group: "General", allowInModal: true });
  return null;
}
