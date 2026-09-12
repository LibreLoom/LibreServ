import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Check, Download, Eye, Maximize2, MoreHorizontal, Pencil, Save, X } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import PageNotice from "../common/PageNotice.jsx";
import SegmentedControl from "../common/SegmentedControl.jsx";
import ShakeTarget from "../ui/ShakeTarget.jsx";
import ImagePreviewPanel from "./ImagePreviewPanel.jsx";
import MarkdownEditor from "./MarkdownEditor.jsx";
import KindViewer from "./viewers/KindViewer.jsx";
import PdfViewer from "./viewers/PdfAudioViewers.jsx";
import EbookViewer from "./viewers/EbookFontViewers.jsx";
import OfficeEditor from "./office/OfficeEditor.jsx";
import { probeEuroOffice } from "./office/euroOfficeApi.js";
import { apiErrorMessage, apiFetch, postForm } from "../../lib/api.js";
import { isEbookFile, isPdfFile, openableKind } from "../../lib/fileKinds.js";
import { contentHref, downloadHref, pathBasename } from "../../lib/paths.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics.js";

/** Match `file-viewer-out` duration in index.css. */
const FULLSCREEN_EXIT_MS = 250;

/** Under this age the office save indicator reads "Saved just now". */
const RECENT_SAVE_MS = 90_000;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const MD_UP_QUERY = "(min-width: 768px)";

/**
 * jsdom has no layout CSS, so the office chrome picks one branch via
 * matchMedia — same convention as Table.jsx. Missing matchMedia (SSR / some
 * tests) is treated as desktop.
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
 * Hold a portaled fullscreen overlay mounted while its exit animation plays —
 * same deferred-unmount pattern as FileSearch/ModalCard. `present` follows
 * `active` up synchronously (so the enter animation starts on the same commit)
 * and drops one `file-viewer-out` duration after `active` goes false.
 *
 * @param {boolean} active
 * @returns {{ present: boolean, isClosing: boolean }}
 */
function useOverlayPresence(active) {
  const [present, setPresent] = useState(active);
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const isClosing = present && !active;

  // Re-open synchronously so a reactivation mid-exit never drops a frame.
  if (active && !present) {
    setPresent(true);
  }

  useEffect(() => {
    if (active) {
      if (exitTimerRef.current != null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      return;
    }
    if (!present || exitTimerRef.current != null) return;
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setPresent(false);
    }, prefersReducedMotion() ? 0 : FULLSCREEN_EXIT_MS);
  }, [active, present]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) clearTimeout(exitTimerRef.current);
  }, []);

  return { present, isClosing };
}

/**
 * View images/videos or edit plaintext for a drive file.
 * Office files stay in the normal modal while EuroOffice is missing or still
 * checking, and open fullscreen only when EuroOffice is ready.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   onClose: () => void,
 *   onSaved?: () => void,
 *   open?: boolean,
 *   canWrite?: boolean,
 * }} props
 */
export default function FileViewer({ driveId, path, onClose, onSaved, open = true, canWrite = true }) {
  const name = pathBasename(path) || path;
  const kind = openableKind(name);
  const isOffice = kind === "office";
  const isMarkdown = kind === "markdown";
  // Text-like kinds share the load/save chrome; markdown swaps the editor surface.
  const isEditableText = kind === "text" || isMarkdown;
  const [officePhase, setOfficePhase] = useState(
    /** @type {"checking"|"ready"|"missing"} */ ("checking"),
  );
  // Presence string is plumbed through to OfficeEditor but not rendered yet —
  // collab presence UI will be redesigned separately.
  const [, setOfficePresence] = useState("");
  // EuroOffice save chrome in the fullscreen frame (desktop rail / mobile
  // options menu): the editor registers a
  // save thunk once a writable session is up and reports dirty/saved via
  // onSaveStateChange (onDocumentStateChange: true = unsaved edits, false =
  // all changes saved).
  const [officeSaveReady, setOfficeSaveReady] = useState(false);
  const [officeHasUnsaved, setOfficeHasUnsaved] = useState(false);
  const [officeSavedAt, setOfficeSavedAt] = useState(/** @type {number | null} */ (null));
  const [officeSaving, setOfficeSaving] = useState(false);
  const [officeSaveError, setOfficeSaveError] = useState("");
  const officeSaveFnRef = useRef(/** @type {(() => Promise<unknown>) | null} */ (null));
  // "Document Unsaved" guard modal. The ref mirrors the state so the window
  // capture-phase Escape handler can yield to the modal without re-registering.
  const [confirmOfficeClose, setConfirmOfficeClose] = useState(false);
  const confirmOfficeCloseRef = useRef(false);
  confirmOfficeCloseRef.current = confirmOfficeClose;
  // Mobile office chrome: the compact top bar's "···" menu. The ref mirrors
  // the state so the window capture-phase Escape handler can yield to the
  // menu's own document listener, same as the guard modal above.
  const [officeMenuOpen, setOfficeMenuOpen] = useState(false);
  const [officeMenuClosing, setOfficeMenuClosing] = useState(false);
  const [officeMenuPos, setOfficeMenuPos] = useState({ top: 0, left: 0 });
  const [officeMenuIndex, setOfficeMenuIndex] = useState(0);
  const officeMenuOpenRef = useRef(false);
  officeMenuOpenRef.current = officeMenuOpen;
  const officeMenuTriggerRef = useRef(/** @type {HTMLSpanElement|null} */ (null));
  const officeMenuPortalRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const officeMenuCloseTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  // Desktop shows a left rail, mobile a thin bar + dropdown — jsdom has no
  // layout, so the branch is chosen by matchMedia (see useIsMdUp).
  const isMdUp = useIsMdUp();
  // Re-render once so "Saved just now" rolls over to the clock time.
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(isEditableText);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Read-only markdown opens straight on the rendered preview.
  const [mdView, setMdView] = useState(/** @type {"edit" | "preview"} */ (canWrite ? "edit" : "preview"));
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const previewKey = `${driveId}:${path}:${open}`;
  const [expandedScope, setExpandedScope] = useState(previewKey);
  const exitButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const officeCloseRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const officeCancelRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const fullViewButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const wasExpandedRef = useRef(false);

  if (expandedScope !== previewKey) {
    setExpandedScope(previewKey);
    setExpanded(false);
    setError(null);
    setOfficePhase("checking");
    setOfficePresence("");
    officeSaveFnRef.current = null;
    setOfficeSaveReady(false);
    setOfficeHasUnsaved(false);
    setOfficeSavedAt(null);
    setOfficeSaving(false);
    setOfficeSaveError("");
    setConfirmOfficeClose(false);
    setOfficeMenuOpen(false);
    setOfficeMenuClosing(false);
    setMdView(canWrite ? "edit" : "preview");
  }

  useEffect(() => {
    if (wasExpandedRef.current && !expanded) {
      fullViewButtonRef.current?.focus();
    }
    wasExpandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return undefined;

    exitButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setExpanded(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        exitButtonRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [expanded]);

  // Unsaved-changes guard: every close path (X button, Escape) funnels through
  // here. Dirty → open the "Document Unsaved" modal; clean → close straight
  // away. During the exit animation officeHasUnsaved is already reset (the
  // previewKey reset flips on `open`), so a stray click just no-ops via onClose.
  const requestOfficeClose = useCallback(() => {
    if (officeHasUnsaved) {
      setOfficeSaveError("");
      setConfirmOfficeClose(true);
    } else {
      onClose();
    }
  }, [officeHasUnsaved, onClose]);

  useEffect(() => {
    const fullscreenOffice = open && isOffice && officePhase === "ready";
    if (!fullscreenOffice) return undefined;

    officeCloseRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        // While the guard modal or the mobile options menu is open it owns
        // Escape — this is a window capture listener and would otherwise eat
        // the keypress before their document listeners see it.
        if (confirmOfficeCloseRef.current || officeMenuOpenRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        haptic("light");
        requestOfficeClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, isOffice, officePhase, requestOfficeClose]);

  // Tab close / navigation while the editor has unsaved changes. The browser
  // shows its own native prompt — a custom dialog is not an option here.
  useEffect(() => {
    if (!officeHasUnsaved) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [officeHasUnsaved]);

  useEffect(() => {
    if (!open || !isOffice) return undefined;
    let cancelled = false;
    // officePhase is already reset to "checking" by the render-phase reset on
    // previewKey (driveId:path:open) — this effect only resolves the probe.
    (async () => {
      const ok = await probeEuroOffice();
      if (!cancelled) setOfficePhase(ok ? "ready" : "missing");
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isOffice, driveId, path]);


  useEffect(() => {
    if (!open || !path || !isEditableText) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this file.");
        const body = await res.text();
        if (!cancelled) {
          setText(body);
          setSavedText(body);
        }
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [driveId, path, isEditableText, open]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const blob = new Blob([text], { type: "text/plain" });
      const file = new File([blob], name, { type: "text/plain" });
      const form = new FormData();
      form.append("path", folder);
      form.append("file", file);
      await postForm(
        `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(folder)}&overwrite=1`,
        form,
      );
      setSavedText(text);
      haptic("success");
      onSaved?.();
    } catch (err) {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't save your changes. Try again."));
    } finally {
      setSaving(false);
    }
  }

  // Stable callbacks — EuroOfficeHost's mount effect depends on them, so an
  // inline identity change would tear the DocsAPI editor down and remount it.
  const handleOfficeSaveState = useCallback((hasUnsaved) => {
    if (hasUnsaved) {
      setOfficeHasUnsaved(true);
    } else {
      setOfficeHasUnsaved(false);
      setOfficeSaveError("");
      setOfficeSavedAt(Date.now());
      setClockNow(Date.now());
    }
  }, []);

  const handleRegisterOfficeSave = useCallback((save) => {
    officeSaveFnRef.current = save || null;
    setOfficeSaveReady(Boolean(save));
  }, []);

  useEffect(() => {
    if (officeSavedAt == null) return undefined;
    const remaining = RECENT_SAVE_MS - (clockNow - officeSavedAt);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setClockNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [officeSavedAt, clockNow]);

  /** Run the registered EuroOffice save thunk. Returns true on success. */
  async function saveOffice() {
    const run = officeSaveFnRef.current;
    if (!run || officeSaving) return false;
    setOfficeSaving(true);
    setOfficeSaveError("");
    try {
      // Resolves once EuroOffice accepts the save; the editor then reports
      // "all changes saved" through onSaveStateChange.
      await run();
      return true;
    } catch (err) {
      haptic("error");
      setOfficeSaveError(apiErrorMessage(err, "Couldn't save. Try again."));
      return false;
    } finally {
      setOfficeSaving(false);
    }
  }

  async function saveOfficeAndClose() {
    const ok = await saveOffice();
    if (!ok) return;
    // The user may have cancelled the modal while the save was in flight —
    // respect that and keep editing instead of closing underneath them.
    if (!confirmOfficeCloseRef.current) return;
    haptic("success");
    setConfirmOfficeClose(false);
    onClose();
  }

  // Mobile options menu — same portaled-dropdown pattern as NewItemMenu /
  // DriveMenu: fixed position under the trigger, outside-mousedown and Escape
  // on document, animate-dropdown-open/close.
  const closeOfficeMenu = useCallback(() => {
    setOfficeMenuClosing(true);
    officeMenuCloseTimerRef.current = setTimeout(() => {
      setOfficeMenuOpen(false);
      setOfficeMenuClosing(false);
      setOfficeMenuIndex(0);
      officeMenuCloseTimerRef.current = null;
    }, 160);
  }, []);

  const updateOfficeMenuPosition = useCallback(() => {
    if (!officeMenuTriggerRef.current) return;
    const rect = officeMenuTriggerRef.current.getBoundingClientRect();
    const menuWidth = officeMenuPortalRef.current?.offsetWidth || Math.max(rect.width, 176);
    let left = rect.left + window.scrollX;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    setOfficeMenuPos({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  const openOfficeMenu = useCallback(() => {
    // Reopening mid-close-animation cancels the pending close.
    if (officeMenuCloseTimerRef.current) {
      clearTimeout(officeMenuCloseTimerRef.current);
      officeMenuCloseTimerRef.current = null;
    }
    updateOfficeMenuPosition();
    setOfficeMenuClosing(false);
    setOfficeMenuOpen(true);
  }, [updateOfficeMenuPosition]);

  useEffect(() => () => {
    if (officeMenuCloseTimerRef.current) clearTimeout(officeMenuCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!officeMenuOpen) return undefined;
    function handleClickOutside(event) {
      if (officeMenuTriggerRef.current?.contains(/** @type {Node|null} */ (event.target))
        || officeMenuPortalRef.current?.contains(/** @type {Node|null} */ (event.target))) return;
      closeOfficeMenu();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        closeOfficeMenu();
        officeMenuTriggerRef.current?.querySelector("button")?.focus();
      }
    }
    function handleScroll() {
      updateOfficeMenuPosition();
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
  }, [officeMenuOpen, closeOfficeMenu, updateOfficeMenuPosition]);

  useLayoutEffect(() => {
    if (!officeMenuOpen) return;
    updateOfficeMenuPosition();
  }, [officeMenuOpen, updateOfficeMenuPosition]);

  function toggleOfficeMenu() {
    if (officeMenuOpen) {
      closeOfficeMenu();
      return;
    }
    haptic("light");
    openOfficeMenu();
  }

  const officeSaveLabel = officeSaving
    ? "Saving…"
    : officeSaveError
      ? officeSaveError
      : officeHasUnsaved
        ? "Unsaved changes"
        : officeSavedAt != null
          ? clockNow - officeSavedAt < RECENT_SAVE_MS
            ? "Saved just now"
            : `Saved ${new Date(officeSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : "";

  // Mobile chrome menu items — Save only exists in writable sessions; it is
  // disabled (annotated with the last-saved state) when there is nothing to
  // save, same rule as the desktop rail button.
  const officeMenuItems = [
    ...(canWrite
      ? [{
          id: "save",
          label: "Save",
          icon: Save,
          disabled: !officeSaveReady || !officeHasUnsaved,
          note: officeSaveLabel,
          run: () => void saveOffice(),
        }]
      : []),
    {
      id: "close",
      label: "Close editor",
      icon: X,
      disabled: false,
      note: "",
      run: requestOfficeClose,
    },
  ];

  function pickOfficeMenuItem(item) {
    if (item.disabled) return;
    haptic("selection");
    item.run();
    closeOfficeMenu();
  }

  function handleOfficeMenuKeyDown(event) {
    if (!officeMenuItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOfficeMenuIndex((prev) => (prev + 1) % officeMenuItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOfficeMenuIndex((prev) => (prev - 1 + officeMenuItems.length) % officeMenuItems.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = officeMenuItems[officeMenuIndex];
      if (item) pickOfficeMenuItem(item);
    }
  }

  const title =
    kind === "image" ? name
      : kind === "video" ? name
        : isEditableText ? (canWrite ? `Edit ${name}` : name)
          : isOffice ? name
            : name;

  const isDirty = text !== savedText;
  const canFullView = kind === "image" || kind === "video";

  const officeReady = open && isOffice && officePhase === "ready";
  const officeInModal = open && isOffice && officePhase !== "ready";
  // Fullscreen shells animate out after `open`/`expanded` drop — keep them
  // mounted until the exit keyframes finish.
  const officeOverlay = useOverlayPresence(officeReady);
  const fullViewActive = open && expanded && canFullView;
  const fullViewOverlay = useOverlayPresence(fullViewActive);

  if (officeReady || officeOverlay.present) {
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
              officeOverlay.isClosing ? "file-viewer-exit" : "file-viewer-enter",
            )}
          >
            <div className="flex min-h-0 flex-1">
              <div
                data-slot="office-frame"
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary text-primary md:flex-row"
              >
                {isMdUp ? (
                  /* Desktop rail: the filename runs down the left edge like a
                     book spine; save/close controls pin to the bottom. The
                     frame is squared and edge-to-edge, so the rail needs no
                     corner clipping. */
                  <div
                    data-slot="office-rail"
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
                      {canWrite ? (
                        /* Dirty state reads on the button itself: inverted
                           primary fill when there are changes to save, muted
                           ghost when clean. The status text lives in the
                           tooltip only. */
                        <Button
                          variant={officeSaveReady && officeHasUnsaved ? "primary" : "ghost"}
                          surface="secondary"
                          size="icon"
                          smoothResize={false}
                          haptic="light"
                          loading={officeSaving}
                          disabled={!officeSaveReady || !officeHasUnsaved}
                          onClick={() => void saveOffice()}
                          aria-label="Save"
                          tooltip={officeSaveLabel || "Save"}
                        >
                          <Save size={ICON_SIZE.xl} aria-hidden="true" />
                        </Button>
                      ) : null}
                      {/* React 19 ref-as-prop: Button spreads ...props onto the
                          <button>, so officeCloseRef still reaches the DOM node
                          the open effect above focuses. */}
                      <Button
                        ref={officeCloseRef}
                        variant="ghost"
                        surface="secondary"
                        size="icon"
                        smoothResize={false}
                        haptic="light"
                        onClick={requestOfficeClose}
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
                    data-slot="office-topbar"
                    className="flex h-10 shrink-0 items-center gap-2 border-b border-primary/20 bg-secondary pl-4 pr-1.5 text-primary"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-primary"
                      title={name}
                    >
                      {name}
                    </span>
                    <span ref={officeMenuTriggerRef} className="inline-flex">
                      <Button
                        ref={officeCloseRef}
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        smoothResize={false}
                        haptic="light"
                        aria-haspopup="menu"
                        aria-expanded={officeMenuOpen}
                        aria-label="Editor options"
                        onClick={toggleOfficeMenu}
                      >
                        <MoreHorizontal size={ICON_SIZE.lg} aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                )}
                <div className="min-h-0 min-w-0 flex-1 bg-primary text-secondary">
                  <OfficeEditor
                    driveId={driveId}
                    path={path}
                    canWrite={canWrite}
                    onSaved={onSaved}
                    onClose={onClose}
                    onPresenceChange={setOfficePresence}
                    onSaveStateChange={handleOfficeSaveState}
                    onRegisterSave={handleRegisterOfficeSave}
                    /* Freeze on "ready" while exiting — the open→false reset flips
                       officePhase to "checking", which would swap the DocsAPI editor
                       for the checking spinner mid-animation. */
                    phase={officeOverlay.isClosing ? "ready" : officePhase}
                    layout="fullscreen"
                  />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
        {/* Mobile options menu — z-[90] sits above the z-[80] editor overlay. */}
        {officeMenuOpen
          ? createPortal(
            <div
              ref={officeMenuPortalRef}
              role="menu"
              aria-label="Editor options"
              tabIndex={-1}
              onKeyDown={handleOfficeMenuKeyDown}
              style={{ position: "absolute", top: officeMenuPos.top, left: officeMenuPos.left }}
              className={cn(
                "bg-secondary text-primary ring-inset ring-2 ring-accent",
                "rounded-large-element z-[90] overflow-hidden min-w-[12rem]",
                officeMenuClosing ? "animate-dropdown-close" : "animate-dropdown-open",
              )}
            >
              {officeMenuItems.map((item, index) => {
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
                            index === officeMenuIndex ? "bg-primary/10" : "hover:bg-primary/10",
                          ),
                      officeMenuClosing ? "" : "animate-dropdown-option",
                    )}
                    style={officeMenuClosing ? undefined : { animationDelay: `${index * 45}ms` }}
                    onMouseEnter={() => setOfficeMenuIndex(index)}
                    onClick={() => pickOfficeMenuItem(item)}
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
          open={confirmOfficeClose}
          onClose={() => setConfirmOfficeClose(false)}
          title="Document Unsaved"
          showCloseButton={false}
          overlayClassName={NESTED_OVERLAY_CLASS}
          initialFocusRef={officeCancelRef}
        >
          {({ close }) => (
            <div className="space-y-4">
              <p className="text-sm text-primary">
                Closing now loses everything you changed since the last save.
              </p>
              {officeSaveError ? (
                <PageNotice variant="error" surface="secondary">
                  {officeSaveError}
                </PageNotice>
              ) : null}
              <div className="flex flex-col gap-3">
                <Button
                  ref={officeCancelRef}
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
                  loading={officeSaving}
                  disabled={!officeSaveReady}
                  onClick={() => void saveOfficeAndClose()}
                >
                  <Save size={ICON_SIZE.sm} aria-hidden="true" />
                  Save and close
                </Button>
                <Button
                  variant="accent"
                  surface="secondary"
                  fullWidth
                  onClick={() => {
                    setConfirmOfficeClose(false);
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


  return (
    <>
      <ModalCard
        open={open}
        title={title}
        size="lg"
        onClose={onClose}
        overlayClassName={expanded ? "invisible pointer-events-none" : ""}
      >
        {({ close }) => (
          <>
            {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

            {kind === "image" && (
              <ImagePreviewPanel
                key={contentHref(driveId, path)}
                src={contentHref(driveId, path)}
                alt={name}
              />
            )}

            {kind === "video" && (
              <div className="rounded-large-element bg-primary text-secondary p-2">
                <video
                  controls
                  className="w-full max-h-[65vh] rounded-large-element"
                  src={contentHref(driveId, path)}
                >
                  Your browser cannot play this video. Download it instead.
                </video>
              </div>
            )}

            {isEditableText && (
              loading ? (
                <p className="text-primary text-sm">Opening…</p>
              ) : isMarkdown ? (
                <MarkdownEditor
                  text={text}
                  onChange={setText}
                  name={name}
                  canWrite={canWrite}
                  view={mdView}
                  error={error}
                />
              ) : (
                <ShakeTarget shake={error}>
                  <textarea
                    className="w-full min-h-[50vh] rounded-large-element bg-primary text-secondary border-2 border-secondary/30 p-4 font-mono text-sm outline-none focus:border-accent"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                    readOnly={!canWrite}
                    aria-label={`Contents of ${name}`}
                  />
                </ShakeTarget>
              )
            )}

            {officeInModal && (
              // pdf/epub route to EuroOffice like every office format, but both
              // still have no-dependency viewers — use them when the pack is
              // not installed instead of showing the "EuroOffice missing" card.
              officePhase === "missing" && isPdfFile(name) ? (
                <PdfViewer driveId={driveId} path={path} />
              ) : officePhase === "missing" && isEbookFile(name) ? (
                <EbookViewer driveId={driveId} path={path} />
              ) : (
                <OfficeEditor
                  driveId={driveId}
                  path={path}
                  canWrite={canWrite}
                  onSaved={onSaved}
                  onClose={onClose}
                  phase={officePhase}
                  layout="modal"
                />
              )
            )}

            {open && kind && kind !== "image" && kind !== "video" && !isEditableText && kind !== "office" && (
              <KindViewer
                kind={kind}
                driveId={driveId}
                path={path}
                canWrite={canWrite}
                onSaved={onSaved}
                onClose={onClose}
              />
            )}

            {!kind && (
              <p className="text-primary text-sm">
                Luna cannot open this kind of file yet. You can download it instead.
              </p>
            )}

            {!officeInModal && (
            <div className="mt-4 flex flex-wrap gap-3">
              {canFullView && (
                <Button
                  variant="outline"
                  surface="secondary"
                  aria-label="Full view"
                  ref={fullViewButtonRef}
                  onClick={() => {
                    haptic("light");
                    setExpanded(true);
                  }}
                >
                  <Maximize2 size={ICON_SIZE.sm} aria-hidden="true" />
                  Full view
                </Button>
              )}
            {isMarkdown && !loading && (
              <SegmentedControl
                options={[
                  { value: "edit", label: "Edit", icon: Pencil },
                  { value: "preview", label: "Preview", icon: Eye },
                ]}
                value={mdView}
                onChange={(v) => setMdView(v === "preview" ? "preview" : "edit")}
                surface="secondary"
                className="self-center"
              />
            )}
            {isEditableText && canWrite && (
              <Button
                variant="accent"
                surface="secondary"
                loading={saving}
                disabled={!isDirty || loading}
                onClick={() => void save()}
              >
                {isDirty ? (
                  <>
                    <Save size={ICON_SIZE.sm} aria-hidden="true" />
                    Save
                  </>
                ) : (
                  <>
                    <Check size={ICON_SIZE.sm} aria-hidden="true" />
                    Saved
                  </>
                )}
              </Button>
            )}
            <Button variant="outline" surface="secondary" asChild>
              <a href={downloadHref(driveId, path)}>
                <Download size={ICON_SIZE.sm} aria-hidden="true" />
                Download
              </a>
            </Button>
            <Button variant="outline" surface="secondary" onClick={close}>
              Close
            </Button>
          </div>
            )}
        </>
      )}
    </ModalCard>

    {(fullViewActive || fullViewOverlay.present) && createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        data-slot="file-viewer-fullview"
        className={cn(
          /* color-scan: ignore-next-line cinema full-screen backdrop */
          "fixed inset-0 z-[80] flex items-center justify-center bg-black",
          fullViewOverlay.isClosing ? "file-viewer-exit" : "file-viewer-enter",
        )}
      >
        <button
          ref={exitButtonRef}
          type="button"
          /* color-scan: ignore-next-line cinema ghost exit button */
          className="absolute top-4 right-4 md:top-6 md:right-6 z-10 flex h-10 w-10 items-center justify-center rounded-pill bg-white/10 text-white hover:bg-white/20 active:bg-white/30 motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black no-focus-outline"
          onClick={() => {
            haptic("light");
            setExpanded(false);
          }}
          aria-label="Exit full view"
        >
          <X size={ICON_SIZE.xxl} aria-hidden="true" />
        </button>

        <div className="relative flex h-full w-full items-center justify-center p-2 sm:p-4 md:p-6">
          {kind === "video" ? (
            <video
              controls
              autoPlay
              className="max-h-full max-w-full rounded-large-element"
              src={contentHref(driveId, path)}
            >
              Your browser cannot play this video. Download it instead.
            </video>
          ) : (
            <img
              src={contentHref(driveId, path)}
              alt={name}
              className="max-h-full max-w-full object-contain select-none motion-safe:animate-page-enter"
            />
          )}
        </div>
      </div>,
      document.body,
    )}
  </>
  );
}

FileViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
  open: PropTypes.bool,
  canWrite: PropTypes.bool,
};
