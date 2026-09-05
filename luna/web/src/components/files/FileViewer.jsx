import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Check, Download, Maximize2, Minimize2, Save } from "lucide-react";
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

  if (expandedScope !== previewKey) {
    setExpandedScope(previewKey);
    setExpanded(false);
    setError(null);
  }

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

  const modalSize = kind === "image" && expanded ? "fullscreen" : "lg";

  return (
    <ModalCard open={open} title={title} size={modalSize} onClose={onClose}>
      {({ close }) => (
        <>
          {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

          {kind === "image" && (
            <ImagePreviewPanel
              key={contentHref(driveId, path)}
              src={contentHref(driveId, path)}
              alt={name}
              expanded={expanded}
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
            {kind === "image" && (
              <Button
                variant="outline"
                surface="secondary"
                aria-label={expanded ? "Normal size" : "Full view"}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? (
                  <Minimize2 size={14} aria-hidden="true" />
                ) : (
                  <Maximize2 size={14} aria-hidden="true" />
                )}
                {expanded ? "Normal size" : "Full view"}
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
