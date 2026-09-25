import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { MoreHorizontal, Save, X } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage } from "../../lib/api.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/** Under this age the save indicator reads "Saved just now". */
const RECENT_SAVE_MS = 90_000;

const MD_UP_QUERY = "(min-width: 768px)";

/**
 * jsdom has no layout CSS, so the chrome picks one branch via matchMedia —
 * same convention as Table.jsx. Missing matchMedia (SSR / some tests) is
 * treated as desktop.
 */
function useIsMdUp() {
  const read = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia(MD_UP_QUERY).matches;
  };
  const [isMdUp, setIsMdUp] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(MD_UP_QUERY);
    const onChange = () => setIsMdUp(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMdUp;
}

/**
 * The standardized fullscreen editor shell: a portaled overlay with a
 * book-spine rail on desktop (filename down the left edge, Save + Close
 * pinned to the bottom) or a thin topbar + "···" menu on mobile. It owns
 * all the editor chrome — save button state machine, the "Document
 * Unsaved" guard modal, save-and-close, `beforeunload`, and capture-phase
 * Escape — so every editor gets identical behavior.
 *
 * The child editor plugs in through a render prop receiving the save
 * contract:
 *   - `onRegisterSave(fn)` — register the save thunk once a writable
 *     session is up (null to unregister). Save stays disabled until then.
 *   - `onSaveStateChange(hasUnsaved)` — report dirty state. `false` means
 *     "everything is saved" and stamps the "Saved just now" indicator, so
 *     only call it on a real save, not on initial load.
 *   - `requestClose()` — the guarded close path (dirty → guard modal).
 *
 * `sessionKey` should change when a different file/editor mounts inside
 * the same frame — the save chrome resets so one file's dirty flag can't
 * leak into the next.
 *
 * @param {{
 *   name: string,
 *   sessionKey: string,
 *   isClosing?: boolean,
 *   canWrite?: boolean,
 *   editorKind?: string,
 *   presence?: string,
 *   onClose: () => void,
 *   children: (api: {
 *     onRegisterSave: (save: (() => Promise<unknown>) | null) => void,
 *     onSaveStateChange: (hasUnsaved: boolean) => void,
 *     requestClose: () => void,
 *   }) => import("react").ReactNode,
 * }} props
 */
export default function FullscreenEditorFrame({
  name,
  sessionKey,
  isClosing = false,
  canWrite = true,
  editorKind = "office",
  presence = "",
  onClose,
  children,
}) {
  const { addToast } = useToast();
  // Save chrome: the child editor registers a save thunk once a writable
  // session is up and reports dirty/saved via onSaveStateChange.
  const [saveReady, setSaveReady] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [savedAt, setSavedAt] = useState(/** @type {number | null} */ (null));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saveFnRef = useRef(/** @type {(() => Promise<unknown>) | null} */ (null));
  // "Document Unsaved" guard modal. The ref mirrors the state so the window
  // capture-phase Escape handler can yield to the modal without re-registering.
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmCloseRef = useRef(false);
  confirmCloseRef.current = confirmClose;
  // Mobile chrome: the compact top bar's "···" menu. The ref mirrors the
  // state so the window capture-phase Escape handler can yield to the
  // menu's own document listener, same as the guard modal above.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [menuIndex, setMenuIndex] = useState(0);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;
  const menuTriggerRef = useRef(/** @type {HTMLSpanElement|null} */ (null));
  const menuPortalRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const menuCloseTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  // Desktop shows a left rail, mobile a thin bar + dropdown — jsdom has no
  // layout, so the branch is chosen by matchMedia (see useIsMdUp).
  const isMdUp = useIsMdUp();
  // Re-render once so "Saved just now" rolls over to the clock time.
  const [clockNow, setClockNow] = useState(() => Date.now());
  const closeRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const cancelRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  // Tracks whether this session already claimed initial focus — keeps the
  // focus effect's focus() from re-stealing it on every dirty flip (the
  // editor must hold typing focus).
  const focusedRef = useRef(false);

  // A different file inside the same frame — reset the save chrome so the
  // previous editor's dirty flag or save thunk can't leak across. Render-
  // phase reset, same pattern as FileViewer's previewKey scope.
  const [sessionScope, setSessionScope] = useState(sessionKey);
  if (sessionScope !== sessionKey) {
    setSessionScope(sessionKey);
    saveFnRef.current = null;
    setSaveReady(false);
    setHasUnsaved(false);
    setSavedAt(null);
    setSaving(false);
    setSaveError("");
    setConfirmClose(false);
    setMenuOpen(false);
    setMenuClosing(false);
  }

  // Unsaved-changes guard: every close path (X button, Escape) funnels
  // through here. Dirty → open the "Document Unsaved" modal; clean → close
  // straight away.
  const requestClose = useCallback(() => {
    if (hasUnsaved) {
      setSaveError("");
      setConfirmClose(true);
    } else {
      onClose();
    }
  }, [hasUnsaved, onClose]);

  useEffect(() => {
    // Focus the rail's Close button once per session — requestClose changes
    // identity on every dirty-state flip, so re-focusing here on each run
    // would yank typing focus out of the editor mid-keystroke.
    if (!focusedRef.current) {
      focusedRef.current = true;
      closeRef.current?.focus();
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        // While the guard modal or the mobile options menu is open it owns
        // Escape — this is a window capture listener and would otherwise eat
        // the keypress before their document listeners see it.
        if (confirmCloseRef.current || menuOpenRef.current) return;
        // Any other open dialog owns Escape too — without this the frame
        // would close the editor out from under the modal, or stack the
        // unsaved-changes guard on top.
        if (document.querySelector('[data-slot="dialog-overlay"]')) return;
        // CodeMirror panels (search, etc.) own Escape while focus is inside
        // them — let the panel close instead of the whole editor.
        if (
          event.target instanceof Element &&
          event.target.closest(".cm-panel, .cm-tooltip")
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        haptic("light");
        requestClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [requestClose]);

  // While the fullscreen overlay is mounted, flag the root element so
  // global chrome (the Navbar's mobile menu FAB floats above this overlay)
  // can hide over the editor surface.
  useEffect(() => {
    document.documentElement.dataset.lunaEditor = editorKind;
    return () => {
      delete document.documentElement.dataset.lunaEditor;
    };
  }, [editorKind]);

  // Tab close / navigation while the editor has unsaved changes. The browser
  // shows its own native prompt — a custom dialog is not an option here.
  useEffect(() => {
    if (!hasUnsaved) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsaved]);

  // Stable callbacks — child editors' mount effects depend on them, so an
  // inline identity change would tear their session down and remount it.
  const handleSaveState = useCallback((hasUnsavedChanges) => {
    if (hasUnsavedChanges) {
      setHasUnsaved(true);
    } else {
      setHasUnsaved(false);
      setSaveError("");
      setSavedAt(Date.now());
      setClockNow(Date.now());
    }
  }, []);

  const handleRegisterSave = useCallback((save) => {
    saveFnRef.current = save || null;
    setSaveReady(Boolean(save));
  }, []);

  useEffect(() => {
    if (savedAt == null) return undefined;
    const remaining = RECENT_SAVE_MS - (clockNow - savedAt);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setClockNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [savedAt, clockNow]);

  /** Run the registered save thunk. Returns true on success. */
  async function runSave() {
    const run = saveFnRef.current;
    if (!run || saving) return false;
    setSaving(true);
    setSaveError("");
    try {
      // Resolves true once the file is rewritten on Luna. False means the
      // save never ran (a peer's save holds the lock, or one is already in
      // flight) — surface it like a failure so the dirty flag and any
      // save-and-close flow can't slip through.
      const saved = await run();
      if (saved === false) {
        haptic("error");
        setSaveError(
          "Couldn't save — another save is already in progress. Try again in a moment.",
        );
        return false;
      }
      return true;
    } catch (err) {
      haptic("error");
      setSaveError(apiErrorMessage(err, "Couldn't save. Try again."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndClose() {
    const ok = await runSave();
    if (!ok) return;
    // The user may have cancelled the modal while the save was in flight —
    // respect that and keep editing instead of closing underneath them.
    if (!confirmCloseRef.current) return;
    addToast({ type: "success", message: "Changes saved." });
    setConfirmClose(false);
    onClose();
  }

  // Mobile options menu — same portaled-dropdown pattern as NewItemMenu /
  // DriveMenu: fixed position under the trigger, outside-mousedown and Escape
  // on document, animate-dropdown-open/close.
  const closeMenu = useCallback(() => {
    setMenuClosing(true);
    menuCloseTimerRef.current = setTimeout(() => {
      setMenuOpen(false);
      setMenuClosing(false);
      setMenuIndex(0);
      menuCloseTimerRef.current = null;
    }, 160);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (!menuTriggerRef.current) return;
    const rect = menuTriggerRef.current.getBoundingClientRect();
    const menuWidth = menuPortalRef.current?.offsetWidth || Math.max(rect.width, 176);
    let left = rect.left + window.scrollX;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    setMenuPos({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  const openMenu = useCallback(() => {
    // Reopening mid-close-animation cancels the pending close.
    if (menuCloseTimerRef.current) {
      clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
    updateMenuPosition();
    setMenuClosing(false);
    setMenuOpen(true);
  }, [updateMenuPosition]);

  useEffect(() => () => {
    if (menuCloseTimerRef.current) clearTimeout(menuCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function handleClickOutside(event) {
      if (menuTriggerRef.current?.contains(/** @type {Node|null} */ (event.target))
        || menuPortalRef.current?.contains(/** @type {Node|null} */ (event.target))) return;
      closeMenu();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        closeMenu();
        menuTriggerRef.current?.querySelector("button")?.focus();
      }
    }
    function handleScroll() {
      updateMenuPosition();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [menuOpen, closeMenu, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  function toggleMenu() {
    if (menuOpen) {
      closeMenu();
      return;
    }
    haptic("light");
    openMenu();
  }

  const saveLabel = saving
    ? "Saving…"
    : saveError
      ? saveError
      : hasUnsaved
        ? "Unsaved changes"
        : savedAt != null
          ? clockNow - savedAt < RECENT_SAVE_MS
            ? "Saved just now"
            : `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "";

  // Mobile chrome menu items — Save only exists in writable sessions; it is
  // disabled (annotated with the last-saved state) when there is nothing to
  // save, same rule as the desktop rail button.
  const menuItems = [
    ...(canWrite
      ? [{
          id: "save",
          label: "Save",
          icon: Save,
          disabled: !saveReady || !hasUnsaved,
          note: saveLabel,
          run: () => void runSave(),
        }]
      : []),
    {
      id: "close",
      label: "Close editor",
      icon: X,
      disabled: false,
      note: "",
      run: requestClose,
    },
  ];

  function pickMenuItem(item) {
    if (item.disabled) return;
    haptic("selection");
    item.run();
    closeMenu();
  }

  function handleMenuKeyDown(event) {
    if (!menuItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex((prev) => (prev + 1) % menuItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex((prev) => (prev - 1 + menuItems.length) % menuItems.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = menuItems[menuIndex];
      if (item) pickMenuItem(item);
    }
  }

  return (
    <>
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={name}
          data-slot="file-viewer-overlay"
          className={cn(
            "fixed inset-0 z-[80] flex flex-col bg-primary text-secondary",
            isClosing
              ? "fullscreen-overlay-exit file-viewer-exit"
              : "fullscreen-overlay-enter file-viewer-enter",
          )}
        >
          <div className="flex min-h-0 flex-1">
            <div
              data-slot="editor-frame"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary text-primary md:flex-row"
            >
              {isMdUp ? (
                /* Desktop rail: the filename runs down the left edge like a
                   book spine; save/close controls pin to the bottom. The
                   frame is squared and edge-to-edge, so the rail needs no
                   corner clipping. */
                <div
                  data-slot="editor-rail"
                  // Focus contract, half 1: chrome never takes DOM focus on
                  // mouse press (keyboard Tab/Enter is unaffected). The
                  // EuroOffice iframe types through a hidden sink that only
                  // re-arms on an element-focus event that never fires when
                  // the frame's focus leaves and returns — a rail click
                  // killed typing. The frame's focus watchdog (half 2,
                  // watchEuroOfficeFocus) heals whatever still slips through.
                  onMouseDown={(e) => e.preventDefault()}
                  className="flex w-14 shrink-0 flex-col items-center border-r border-primary/20 bg-secondary py-3 text-primary"
                >
                  <div className="flex min-h-0 flex-1 items-start justify-center overflow-hidden">
                    <span
                      className="max-h-full truncate font-mono text-xs text-primary [writing-mode:vertical-rl]"
                      title={name}
                    >
                      {name}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-center gap-2 pt-2">
                    {presence ? (
                      <Tooltip content={presence} surface="secondary">
                        <span
                          role="status"
                          aria-live="polite"
                          data-slot="editor-presence"
                          className="flex h-8 w-8 items-center justify-center rounded-pill bg-primary text-secondary"
                        >
                          <span className="h-2 w-2 rounded-pill bg-accent" aria-hidden="true" />
                          <span className="sr-only">{presence}</span>
                        </span>
                      </Tooltip>
                    ) : null}
                    {canWrite ? (
                      /* Dirty state reads on the button itself: inverted
                         primary fill when there are changes to save, muted
                         ghost when clean. The status text lives in the
                         tooltip only. */
                      <Button
                        variant={saveReady && hasUnsaved ? "primary" : "ghost"}
                        surface="secondary"
                        size="icon"
                        smoothResize={false}
                        haptic="light"
                        loading={saving}
                        disabled={!saveReady || !hasUnsaved}
                        onClick={() => void runSave()}
                        aria-label="Save"
                        tooltip={saveLabel || "Save"}
                      >
                        <Save size={ICON_SIZE.xl} aria-hidden="true" />
                      </Button>
                    ) : null}
                    {/* React 19 ref-as-prop: Button spreads ...props onto the
                        <button>, so closeRef still reaches the DOM node the
                        focus effect above targets. */}
                    <Button
                      ref={closeRef}
                      variant="ghost"
                      surface="secondary"
                      size="icon"
                      smoothResize={false}
                      haptic="light"
                      onClick={requestClose}
                      aria-label="Close editor"
                    >
                      <X size={ICON_SIZE.xl} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : (
                /* Mobile bar: one thin strip — filename plus a "···" menu
                   holding Close and Save, so the editor keeps ~95% of the
                   viewport height. */
                <div
                  data-slot="editor-topbar"
                  // Same rule as the rail — a chrome click must not pull
                  // DOM focus out of the editor frame.
                  onMouseDown={(e) => e.preventDefault()}
                  className="flex h-10 shrink-0 items-center gap-2 border-b border-primary/20 bg-secondary pl-4 pr-1.5 text-primary"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-primary"
                    title={name}
                  >
                    {name}
                  </span>
                  {presence ? (
                    <span
                      role="status"
                      aria-live="polite"
                      data-slot="editor-presence"
                      className="max-w-[40%] shrink-0 truncate font-mono text-xs text-primary"
                    >
                      {presence}
                    </span>
                  ) : null}
                  <span ref={menuTriggerRef} className="inline-flex">
                    <Button
                      ref={closeRef}
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      smoothResize={false}
                      haptic="light"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-label="Editor options"
                      onClick={toggleMenu}
                    >
                      <MoreHorizontal size={ICON_SIZE.lg} aria-hidden="true" />
                    </Button>
                  </span>
                </div>
              )}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary text-secondary">
                {children({
                  onRegisterSave: handleRegisterSave,
                  onSaveStateChange: handleSaveState,
                  requestClose,
                })}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* Mobile options menu — z-[90] sits above the z-[80] editor overlay. */}
      {menuOpen
        ? createPortal(
          <div
            ref={menuPortalRef}
            role="menu"
            aria-label="Editor options"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            style={{ position: "absolute", top: menuPos.top, left: menuPos.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element z-[90] overflow-hidden min-w-[12rem]",
              menuClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            {menuItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={cn(
                    "w-full flex items-center gap-2 px-4 py-2 text-sm text-left",
                    "text-primary font-mono motion-safe:transition-all motion-safe:duration-150",
                    item.disabled
                      ? "cursor-not-allowed opacity-50"
                      : cn(
                          "cursor-pointer",
                          index === menuIndex
                            ? "bg-primary/10 motion-safe:translate-x-0.5"
                            : "hover:bg-primary/10 hover:motion-safe:translate-x-0.5",
                        ),
                    menuClosing ? "" : "animate-dropdown-option",
                  )}
                  style={menuClosing ? undefined : { animationDelay: `${index * 45}ms` }}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => pickMenuItem(item)}
                >
                  <Icon size={ICON_SIZE.sm} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.note ? (
                    <span className="max-w-[10rem] shrink-0 truncate font-mono text-xs text-accent">
                      {item.note}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )
        : null}
      {/* Unsaved-changes guard — z-[90] sits above the z-[80] editor overlay. */}
      <ModalCard
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Document Unsaved"
        showCloseButton={false}
        overlayClassName={NESTED_OVERLAY_CLASS}
        initialFocusRef={cancelRef}
      >
        {({ close }) => (
          <div className="space-y-4">
            <p className="text-sm text-primary">
              Closing now loses everything you changed since the last save.
            </p>
            {saveError ? (
              <PageNotice variant="error" surface="secondary">
                {saveError}
              </PageNotice>
            ) : null}
            <div className="flex flex-col gap-3">
              <Button
                ref={cancelRef}
                variant="outline"
                surface="secondary"
                fullWidth
                haptic={false}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                surface="secondary"
                fullWidth
                loading={saving}
                disabled={!saveReady}
                onClick={() => void saveAndClose()}
              >
                <Save size={ICON_SIZE.sm} aria-hidden="true" />
                Save and close
              </Button>
              <Button
                variant="accent"
                surface="secondary"
                fullWidth
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
              >
                Close anyway
              </Button>
            </div>
          </div>
        )}
      </ModalCard>
    </>
  );
}

FullscreenEditorFrame.propTypes = {
  name: PropTypes.string.isRequired,
  sessionKey: PropTypes.string.isRequired,
  isClosing: PropTypes.bool,
  canWrite: PropTypes.bool,
  editorKind: PropTypes.string,
  presence: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  children: PropTypes.func.isRequired,
};
