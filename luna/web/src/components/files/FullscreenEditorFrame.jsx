import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Save, Share2, X } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { useSmoothResize } from "@libreloom/ui/hooks/useSmoothResize.js";
import { apiErrorMessage } from "../../lib/api.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import DocumentLoadingScreen from "./DocumentLoadingScreen.jsx";
import SlowLoadNotice from "./SlowLoadNotice.jsx";
import { EditorLoadingContext } from "./editorLoadingContext.js";

const MD_UP_QUERY = "(min-width: 768px)";

/**
 * The save pill resizes with `useSmoothResize`, which writes its own inline
 * width transition and so can't be switched off with a `motion-safe:` class.
 * Read the preference here instead and skip the animation when it's on.
 */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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
 * pinned to the bottom) or a thin topbar on mobile (filename, save status,
 * Close). It owns all the editor chrome — save button state machine, the
 * "Document Unsaved" guard modal, save-and-close, `beforeunload`, and
 * capture-phase Escape — so every editor gets identical behavior.
 *
 * The child editor plugs in through a render prop receiving the save
 * contract:
 *   - `onRegisterSave(fn)` — register the save thunk once a writable
 *     session is up (null to unregister). Save stays disabled until then.
 *   - `onSaveStateChange(hasUnsaved)` — report dirty state. `false` means
 *     "everything is saved" and clears any save error, so only call it on
 *     a real save, not on initial load.
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
 *   onShare?: (() => void) | null,
 *   editorKind?: string,
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
  onShare = null,
  editorKind = "office",
  onClose,
  children,
}) {
  const { addToast } = useToast();
  // Save chrome: the child editor registers a save thunk once a writable
  // session is up and reports dirty/saved via onSaveStateChange.
  const [saveReady, setSaveReady] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saveFnRef = useRef(/** @type {(() => Promise<unknown>) | null} */ (null));
  // "Document Unsaved" guard modal. The ref mirrors the state so the window
  // capture-phase Escape handler can yield to the modal without re-registering.
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmCloseRef = useRef(false);
  confirmCloseRef.current = confirmClose;
  // Desktop shows a left rail, mobile a thin bar — jsdom has no layout, so
  // the branch is chosen by matchMedia (see useIsMdUp).
  const isMdUp = useIsMdUp();
  // The mobile save pill animates its width between the three states. The
  // hook writes the width itself, so it is turned off under reduced motion
  // rather than with a `motion-safe:` class.
  const savePillRef = useRef(/** @type {HTMLSpanElement | null} */ (null));
  useSmoothResize(savePillRef, { x: !prefersReducedMotion() });
  const closeRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const cancelRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  // Tracks whether this session already claimed initial focus — keeps the
  // focus effect's focus() from re-stealing it on every dirty flip (the
  // editor must hold typing focus).
  const focusedRef = useRef(false);

  // One loading screen for the whole open. It stays up until the lazy editor
  // has downloaded (`mounted`) and every loader the editor registered has
  // cleared — it is one element in one place, so the dots never restart.
  const [mounted, setMounted] = useState(false);
  const [loaders, setLoaders] = useState(/** @type {Record<string, string>} */ ({}));
  const loadingApi = useMemo(
    () => ({
      markMounted: () => setMounted(true),
      setLoader: (id, label) =>
        setLoaders((prev) => {
          if (label == null) {
            if (!(id in prev)) return prev;
            const { [id]: _removed, ...rest } = prev;
            return rest;
          }
          return prev[id] === label ? prev : { ...prev, [id]: label };
        }),
    }),
    [],
  );
  const loaderLabels = Object.values(loaders);
  const showLoader = !mounted || loaderLabels.length > 0;
  const loaderLabel = loaderLabels[loaderLabels.length - 1] ?? `Opening ${name}`;

  // A different file inside the same frame — reset the save chrome so the
  // previous editor's dirty flag or save thunk can't leak across. Render-
  // phase reset, same pattern as FileViewer's previewKey scope.
  const [sessionScope, setSessionScope] = useState(sessionKey);
  if (sessionScope !== sessionKey) {
    setSessionScope(sessionKey);
    saveFnRef.current = null;
    setSaveReady(false);
    setHasUnsaved(false);
    setSaving(false);
    setSaveError("");
    setConfirmClose(false);
    setMounted(false);
    setLoaders({});
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
        // While the guard modal is open it owns Escape — this is a window
        // capture listener and would otherwise eat the keypress before the
        // modal's document listener sees it.
        if (confirmCloseRef.current) return;
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
        // Excalidraw owns Escape inside its surface: deselect, closing its
        // menus and dialogs, canceling a draw. Same carve-out the drawio
        // iframe gets by swallowing keys entirely.
        if (
          event.target instanceof Element &&
          event.target.closest(".excalidraw")
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
    }
  }, []);

  const handleRegisterSave = useCallback((save) => {
    saveFnRef.current = save || null;
    setSaveReady(Boolean(save));
  }, []);

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
      // Every successful save announces itself once, here — a plain Save says
      // so just like save-and-close, and closing adds no second toast.
      addToast({ type: "success", message: "Changes saved." });
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
    // runSave already announced the save; closing needs no second toast.
    setConfirmClose(false);
    onClose();
  }

  // Exactly three save states — the file is either saved or it isn't, so
  // there is no "just now" window and no clock time. A failed save is not a
  // fourth state: its message takes the pill's place until the next save
  // clears it, the same way the rail's tooltip shows it.
  const saveLabel = saving
    ? "Saving…"
    : saveError
      ? saveError
      : hasUnsaved
        ? "Unsaved"
        : "Saved";

  return (
    <>
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={name}
          data-slot="file-viewer-overlay"
          className={cn(
            "fixed inset-0 z-[80] flex flex-col surface-primary",
            isClosing
              ? "fullscreen-overlay-exit file-viewer-exit"
              : "fullscreen-overlay-enter file-viewer-enter",
          )}
        >
          <div className="flex min-h-0 flex-1">
            <div
              data-slot="editor-frame"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden surface-secondary md:flex-row"
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
                  className="flex w-14 shrink-0 flex-col items-center border-r border-primary/20 surface-secondary py-3"
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
                    {onShare ? (
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="icon"
                        smoothResize={false}
                        haptic="light"
                        onClick={onShare}
                        aria-label="Share"
                        tooltip="Share"
                      >
                        <Share2 size={ICON_SIZE.xl} aria-hidden="true" />
                      </Button>
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
                        tooltip={saveLabel}
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
                /* Mobile bar: one thin strip — filename, save status, Close —
                   so the editor keeps ~95% of the viewport height. There is
                   no menu: the status pill already says whether the file is
                   saved, and closing is one tap. */
                <div
                  data-slot="editor-topbar"
                  // Same rule as the rail — a chrome click must not pull
                  // DOM focus out of the editor frame.
                  onMouseDown={(e) => e.preventDefault()}
                  className="flex h-10 shrink-0 items-center gap-2 border-b border-primary/20 surface-secondary pl-4 pr-1.5"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-primary"
                    title={name}
                  >
                    {name}
                  </span>
                  {canWrite ? (
                    /* The wrapper is the animated box: useSmoothResize pins
                       its width, so the pill fills it (w-full) and the width
                       transition moves the pill's own background. It stays
                       capped at 40% of the bar, and the text truncates when
                       the filename needs the room. */
                    <span
                      ref={savePillRef}
                      data-slot="save-status"
                      className="inline-flex min-w-0 max-w-[40%] shrink-0 overflow-hidden"
                    >
                      <Pill variant="muted" className="w-full min-w-0 text-primary">
                        <span className="min-w-0 truncate">{saveLabel}</span>
                      </Pill>
                    </span>
                  ) : null}
                  {onShare ? (
                    <Button
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      smoothResize={false}
                      haptic="light"
                      onClick={onShare}
                      aria-label="Share"
                    >
                      <Share2 size={ICON_SIZE.lg} aria-hidden="true" />
                    </Button>
                  ) : null}
                  <Button
                    ref={closeRef}
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    smoothResize={false}
                    haptic="light"
                    onClick={requestClose}
                    aria-label="Close editor"
                  >
                    <X size={ICON_SIZE.lg} aria-hidden="true" />
                  </Button>
                </div>
              )}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col surface-primary">
                <EditorLoadingContext.Provider value={loadingApi}>
                  {children({
                    onRegisterSave: handleRegisterSave,
                    onSaveStateChange: handleSaveState,
                    requestClose,
                  })}
                </EditorLoadingContext.Provider>
                {showLoader ? (
                  <>
                    <DocumentLoadingScreen
                      label={loaderLabel}
                      className="absolute inset-0 z-[5]"
                    />
                    <SlowLoadNotice key={sessionKey} name={name} />
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* Unsaved-changes guard — z-[90] sits above the z-[80] editor overlay. */}
      <ModalCard
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Document unsaved"
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
  onShare: PropTypes.func,
  editorKind: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  children: PropTypes.func.isRequired,
};
