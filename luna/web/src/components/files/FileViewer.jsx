import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Code, Download, Eye, FileOutput, ImageOff, Maximize2, VideoOff, X } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import ImagePreviewPanel from "./ImagePreviewPanel.jsx";
import MarkdownPreview from "./MarkdownPreview.jsx";
import FullscreenEditorFrame from "./FullscreenEditorFrame.jsx";
import TextFileEditor from "./TextFileEditor.jsx";
import FormBuilder from "./forms/FormBuilder.jsx";
import KindViewer from "./viewers/KindViewer.jsx";
import OfficeEditor from "./office/OfficeEditor.jsx";
import DiagramEditor from "./diagram/DiagramEditor.jsx";
import { ApiError, apiErrorMessage, postForm } from "../../lib/api.js";
import { fileExtension, openableKind } from "../../lib/fileKinds.js";
import { officeConversionFor } from "../../lib/officeConvert.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import { joinPath, parentPath, pathBasename } from "../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/** Match `file-viewer-out` duration in index.css. */
const FULLSCREEN_EXIT_MS = 250;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
 * View or edit a drive file. Capability decides the shell:
 *
 * - Writable kinds (office formats, text/markdown with write permission)
 *   mount FullscreenEditorFrame immediately — the frame owns the rail,
 *   save chrome, and the unsaved-changes guard.
 * - Preview-only kinds open in the small modal; images and videos add a
 *   manual "Full view" cinema overlay.
 * - A missing EuroOffice pack is discovered inside the editor mount when
 *   the DocsAPI script fails to load — OfficeEditor then shows its
 *   missing-editor card in the same frame.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   onClose: () => void,
 *   onSaved?: () => void,
 *   onOpenPath?: (path: string) => void,
 *   open?: boolean,
 *   canWrite?: boolean,
 *   name?: string,
 * }} props
 */
export default function FileViewer({ driveId, path, onClose, onSaved, onOpenPath, open = true, canWrite = true, name: nameProp = "" }) {
  const { addToast } = useToast();
  const source = useFileSource();
  const guest = source.guest === true;
  const name = nameProp || pathBasename(path) || path;
  const kind = openableKind(name);
  // Office-adjacent files get a conversion hint; ones we can convert in the
  // browser also get a Convert & open button that writes a copy next to the
  // original and opens it in the editing view.
  const conversion = officeConversionFor(name, kind);
  const isOffice = kind === "office";
  const isForm = kind === "form";
  const isDiagram = kind === "diagram";
  const isMarkdown = kind === "markdown";
  const isTextLike = kind === "text" || isMarkdown;
  // Writable text/markdown gets the fullscreen editor; without write
  // permission the same file is a preview-only kind and stays in the modal.
  // Office, forms, and diagrams always take the fullscreen frame — they keep
  // a useful read-only view when the opener can't write, and link guests
  // reach all three through the scoped /s endpoints.
  const fullscreenEditor =
    isOffice || isForm || isDiagram || (isTextLike && canWrite);
  // Set when EuroOfficeHost reports the DocsAPI script failed to load —
  // OfficeEditor swaps to its "can't open office files" card inside the
  // same fullscreen frame.
  const [officeMissing, setOfficeMissing] = useState(false);
  // Same presence line for EuroOffice and diagrams ("Live · only you",
  // "Live · Ada"). The fullscreen frame renders it.
  const [editorPresence, setEditorPresence] = useState("");
  // Modal-only text preview state — only read for preview-only opens
  // (isTextLike && !canWrite); the fullscreen editor loads its own copy.
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(isTextLike && !canWrite);
  const [mdView, setMdView] = useState(/** @type {"edit" | "preview"} */ ("preview"));
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [converting, setConverting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const previewKey = `${driveId}:${path}:${open}`;
  const [expandedScope, setExpandedScope] = useState(previewKey);
  const exitButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const fullViewButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const wasExpandedRef = useRef(false);
  // Snapshot of officeMissing for the exit animation — see below.
  const officeMissingViewRef = useRef(false);
  // Frozen identity of the mounted editor, for the same exit window: the
  // open→false reset clears `path` to "", which would otherwise swap the
  // office editor for a TextFileEditor on an empty path — a bogus content
  // fetch and an error flash for the last 250ms.
  const frameViewRef = useRef({ path, name, isOffice, isForm, isDiagram, isMarkdown });

  if (expandedScope !== previewKey) {
    setExpandedScope(previewKey);
    setExpanded(false);
    setMediaFailed(false);
    setError(null);
    setConverting(false);
    setOfficeMissing(false);
    setEditorPresence("");
    setMdView("preview");
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

  // EuroOfficeHost reports a missing pack when the DocsAPI script fails to
  // load — the only "is EuroOffice installed" check, riding on the load the
  // editor was going to do anyway.
  const handleOfficeUnavailable = useCallback(() => setOfficeMissing(true), []);

  // Read-only text/markdown preview — writable opens mount TextFileEditor
  // inside the fullscreen frame and load their own copy.
  useEffect(() => {
    // A file link's path is legitimately "" — the source resolves it to the
    // shared file. Only a missing path on a drive source means "nothing open".
    if (!open || (!path && !source.isFile) || !isTextLike || canWrite) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await source.fetch(source.contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this file.");
        const body = await res.text();
        if (!cancelled) setText(body);
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [source, driveId, path, isTextLike, canWrite, open]);

  /** Convert to the adjacent office format, upload the copy, open it. */
  async function convertAndOpen() {
    if (!conversion?.convert || converting) return;
    setConverting(true);
    setError(null);
    try {
      const res = await source.fetch(source.contentHref(driveId, path));
      if (!res.ok) throw new Error("Luna couldn't open this file.");
      const bytes = await res.arrayBuffer();
      const blob = await conversion.convert(bytes, fileExtension(name));
      const folder = parentPath(path) ?? "";
      const ext = fileExtension(name);
      const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
      // `budget.csv` → `budget.xlsx`, then `budget (2).xlsx`, … — the upload
      // refuses to overwrite (409), so a taken name just means try the next.
      let targetPath = null;
      for (let i = 0; i < 50 && !targetPath; i += 1) {
        const fileName = i === 0
          ? `${stem}.${conversion.targetExt}`
          : `${stem} (${i + 1}).${conversion.targetExt}`;
        const candidate = joinPath(folder, fileName);
        const file = new File([blob], fileName, {
          type: blob.type || "application/octet-stream",
        });
        const form = new FormData();
        form.append("path", folder);
        form.append("file", file);
        try {
          await postForm(
            `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(folder)}&overwrite=0`,
            form,
          );
          targetPath = candidate;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
        }
      }
      if (!targetPath) {
        throw new Error(
          "Couldn't create the converted copy — this folder already has too many files with that name. Rename or remove one, then try again.",
        );
      }
      addToast({ type: "success", message: "Converted — the new file is open." });
      onSaved?.();
      onOpenPath?.(targetPath);
    } catch (err) {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't convert that file. Try again."));
    } finally {
      setConverting(false);
    }
  }

  const canFullView = kind === "image" || kind === "video";

  const editorActive = open && fullscreenEditor;
  // Fullscreen shells animate out after `open`/`expanded` drop — keep them
  // mounted until the exit keyframes finish.
  const editorOverlay = useOverlayPresence(editorActive);
  const fullViewActive = open && expanded && canFullView;
  const fullViewOverlay = useOverlayPresence(fullViewActive);

  // Freeze the missing-pack swap and the editor identity while exiting —
  // the open→false reset clears officeMissing and `path` mid-animation,
  // which would trade the mounted editor for a fresh one on an empty path.
  if (!editorOverlay.isClosing) {
    officeMissingViewRef.current = officeMissing;
    frameViewRef.current = { path, name, isOffice, isForm, isDiagram, isMarkdown };
  }
  const officeMissingView = editorOverlay.isClosing
    ? officeMissingViewRef.current
    : officeMissing;
  const frameView = frameViewRef.current;

  if (editorActive || editorOverlay.present) {
    return (
      <FullscreenEditorFrame
        name={frameView.name}
        sessionKey={previewKey}
        isClosing={editorOverlay.isClosing}
        canWrite={canWrite}
        editorKind={frameView.isOffice ? "office" : frameView.isForm ? "form" : frameView.isDiagram ? "diagram" : "text"}
        presence={editorPresence}
        onClose={onClose}
      >
        {({ onRegisterSave, onSaveStateChange, requestClose }) =>
          frameView.isOffice ? (
            <OfficeEditor
              driveId={driveId}
              path={frameView.path}
              canWrite={canWrite}
              onSaved={onSaved}
              onClose={onClose}
              onPresenceChange={setEditorPresence}
              onSaveStateChange={onSaveStateChange}
              onRegisterSave={onRegisterSave}
              onUnavailable={handleOfficeUnavailable}
              missing={officeMissingView}
            />
          ) : frameView.isDiagram ? (
            <DiagramEditor
              driveId={driveId}
              path={frameView.path}
              canWrite={canWrite}
              onSaved={onSaved}
              onClose={onClose}
              onPresenceChange={setEditorPresence}
              onSaveStateChange={onSaveStateChange}
              onRegisterSave={onRegisterSave}
              requestClose={requestClose}
            />
          ) : frameView.isForm ? (
            <FormBuilder
              driveId={driveId}
              path={frameView.path}
              name={frameView.name}
              canWrite={canWrite}
              onSaved={onSaved}
              onRegisterSave={onRegisterSave}
              onSaveStateChange={onSaveStateChange}
            />
          ) : (
            <TextFileEditor
              driveId={driveId}
              path={frameView.path}
              name={frameView.name}
              isMarkdown={frameView.isMarkdown}
              onSaved={onSaved}
              onRegisterSave={onRegisterSave}
              onSaveStateChange={onSaveStateChange}
            />
          )
        }
      </FullscreenEditorFrame>
    );
  }

  return (
    <>
      <ModalCard
        open={open}
        title={name}
        size="lg"
        onClose={onClose}
        overlayClassName={expanded ? "invisible pointer-events-none" : ""}
      >
        {({ close }) => (
          <>
            {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

            {kind === "image" && (
              <ImagePreviewPanel
                key={source.contentHref(driveId, path)}
                src={source.contentHref(driveId, path)}
                alt={name}
              />
            )}

            {kind === "video" && (
              mediaFailed ? (
                <PageNotice variant="error">
                  This video can't play in the browser. Download it to watch on your device.
                </PageNotice>
              ) : (
                <div className="rounded-large-element bg-primary text-secondary p-2">
                  <video
                    controls
                    className="w-full max-h-[65vh] rounded-large-element"
                    src={source.contentHref(driveId, path)}
                    onError={() => setMediaFailed(true)}
                  />
                </div>
              )
            )}

            {isTextLike && !canWrite && (
              loading ? (
                <div
                  className="flex min-h-[50vh] items-center justify-center"
                  role="status"
                  aria-label={`Opening ${name}`}
                >
                  <div className="flex items-center gap-3 text-primary">
                    <p className="font-mono text-sm uppercase tracking-widest">
                      Opening
                    </p>
                    <Spinner size="md" decorative />
                  </div>
                </div>
              ) : isMarkdown ? (
                mdView === "preview" ? (
                  <MarkdownPreview
                    text={text}
                    name={name}
                    className="max-h-[65vh] min-h-[50vh] rounded-large-element"
                    emptyHint="Nothing to preview yet."
                  />
                ) : (
                  <ShakeTarget shake={error}>
                    <pre
                      aria-label={`Contents of ${name}`}
                      className="max-h-[65vh] min-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-large-element bg-primary p-4 font-mono text-sm text-secondary"
                    >
                      {text}
                    </pre>
                  </ShakeTarget>
                )
              ) : (
                <ShakeTarget shake={error}>
                  <textarea
                    className="w-full min-h-[50vh] rounded-large-element bg-primary p-4 font-mono text-sm text-secondary outline-none resize-none"
                    value={text}
                    readOnly
                    spellCheck={false}
                    aria-label={`Contents of ${name}`}
                  />
                </ShakeTarget>
              )
            )}

            {open && kind && kind !== "image" && kind !== "video" && !isTextLike && kind !== "office" && kind !== "form" && kind !== "diagram" && (
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

            {conversion && !guest && (
              <p className="mt-3 text-sm text-primary">
                You can open this file in the editing view by converting it to a{" "}
                <span className="font-mono">.{conversion.targetExt}</span> file.
                {conversion.convert && canWrite
                  ? ""
                  : " Convert it on another device, then upload the copy here."}
              </p>
            )}

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
              {isMarkdown && !canWrite && !loading && (
                <SegmentedControl
                  options={[
                    { value: "preview", label: "Preview", icon: Eye },
                    { value: "edit", label: "Source", icon: Code },
                  ]}
                  value={mdView}
                  onChange={(v) => setMdView(v === "preview" ? "preview" : "edit")}
                  surface="secondary"
                  className="self-center"
                />
              )}
              {conversion?.convert && canWrite && !guest && (
                <Button
                  variant="accent"
                  surface="secondary"
                  loading={converting}
                  onClick={() => void convertAndOpen()}
                >
                  <FileOutput size={ICON_SIZE.sm} aria-hidden="true" />
                  Convert & open
                </Button>
              )}
              <Button variant="outline" surface="secondary" asChild>
                <a href={source.downloadHref(driveId, path)}>
                  <Download size={ICON_SIZE.sm} aria-hidden="true" />
                  Download
                </a>
              </Button>
              <Button variant="outline" surface="secondary" onClick={close}>
                Close
              </Button>
            </div>
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
            fullViewOverlay.isClosing
              ? "fullscreen-overlay-exit file-viewer-exit"
              : "fullscreen-overlay-enter file-viewer-enter",
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
            {mediaFailed ? (
              <div
                role="alert"
                className="flex max-w-sm flex-col items-center gap-3 rounded-large-element bg-secondary px-8 py-6 text-center text-primary"
              >
                {kind === "video" ? (
                  <VideoOff size={28} aria-hidden="true" />
                ) : (
                  <ImageOff size={28} aria-hidden="true" />
                )}
                <p className="text-sm">
                  {kind === "video"
                    ? "This video can't play in the browser. Download it to watch on your device."
                    : "This photo can't be displayed in the browser. Download it to try opening it on your device."}
                </p>
                <Button variant="primary" size="sm" asChild>
                  <a href={source.downloadHref(driveId, path)} download>
                    <Download size={ICON_SIZE.sm} aria-hidden="true" />
                    Download
                  </a>
                </Button>
              </div>
            ) : kind === "video" ? (
              <video
                controls
                autoPlay
                className="h-full w-full rounded-large-element object-contain"
                src={source.contentHref(driveId, path)}
                onError={() => setMediaFailed(true)}
              />
            ) : (
              <img
                src={source.contentHref(driveId, path)}
                alt={name}
                className="h-full w-full object-contain select-none motion-safe:animate-page-enter"
                onError={() => setMediaFailed(true)}
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
  onOpenPath: PropTypes.func,
  open: PropTypes.bool,
  canWrite: PropTypes.bool,
  name: PropTypes.string,
};
