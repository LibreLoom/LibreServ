import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Check, Download, Maximize2, Save, X } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import PageNotice from "../common/PageNotice.jsx";
import ShakeTarget from "../ui/ShakeTarget.jsx";
import ImagePreviewPanel from "./ImagePreviewPanel.jsx";
import { apiErrorMessage, apiFetch, postForm } from "../../lib/api.js";
import { openableKind } from "../../lib/fileKinds.js";
import { contentHref, downloadHref, pathBasename } from "../../lib/paths.js";

/**
 * View images/videos or edit plaintext for a drive file.
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
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(kind === "text");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const previewKey = `${driveId}:${path}:${open}`;
  const [expandedScope, setExpandedScope] = useState(previewKey);
  const exitButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const fullViewButtonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const wasExpandedRef = useRef(false);

  if (expandedScope !== previewKey) {
    setExpandedScope(previewKey);
    setExpanded(false);
    setError(null);
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

  useEffect(() => {
    if (!open || !path || kind !== "text") return undefined;
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
  }, [driveId, path, kind, open]);

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
      onSaved?.();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save your changes. Try again."));
    } finally {
      setSaving(false);
    }
  }

  const title =
    kind === "image" ? name
      : kind === "video" ? name
        : kind === "text" ? (canWrite ? `Edit ${name}` : name)
          : name;

  const isDirty = text !== savedText;
  const canFullView = kind === "image" || kind === "video";

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

            {kind === "text" && (
              loading ? (
                <p className="text-primary text-sm">Opening…</p>
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

            {!kind && (
              <p className="text-primary text-sm">
                Luna cannot open this kind of file yet. You can download it instead.
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-3">
              {canFullView && (
                <Button
                  variant="outline"
                  surface="secondary"
                  aria-label="Full view"
                  ref={fullViewButtonRef}
                  onClick={() => setExpanded(true)}
                >
                  <Maximize2 size={14} aria-hidden="true" />
                  Full view
                </Button>
              )}
            {kind === "text" && canWrite && (
              <Button
                variant="accent"
                surface="secondary"
                loading={saving}
                disabled={!isDirty || loading}
                onClick={() => void save()}
              >
                {isDirty ? (
                  <>
                    <Save size={14} aria-hidden="true" />
                    Save
                  </>
                ) : (
                  <>
                    <Check size={14} aria-hidden="true" />
                    Saved
                  </>
                )}
              </Button>
            )}
            <Button variant="outline" surface="secondary" asChild>
              <a href={downloadHref(driveId, path)}>
                <Download size={14} aria-hidden="true" />
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

    {open && expanded && canFullView && createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        /* color-scan: ignore-next-line cinema full-screen backdrop */
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black motion-safe:transition-opacity motion-safe:duration-200"
      >
        <button
          ref={exitButtonRef}
          type="button"
          /* color-scan: ignore-next-line cinema ghost exit button */
          className="absolute top-4 right-4 md:top-6 md:right-6 z-10 flex h-10 w-10 items-center justify-center rounded-pill bg-white/10 text-white hover:bg-white/20 active:bg-white/30 motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black no-focus-outline"
          onClick={() => setExpanded(false)}
          aria-label="Exit full view"
        >
          <X size={22} aria-hidden="true" />
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
