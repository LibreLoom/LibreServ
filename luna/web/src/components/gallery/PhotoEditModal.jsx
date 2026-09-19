import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import { ABOVE_LIGHTBOX_OVERLAY_CLASS } from "./PhotoLightbox.jsx";
import { contentHref } from "../../lib/paths.js";
import { apiErrorMessage, postForm, postJson } from "../../lib/api";

/**
 * Minimal rotate editor. Prefers POST /api/v1/gallery/edit; falls back
 * to canvas JPEG upload beside the original.
 *
 * @param {{
 *   open: boolean,
 *   photo: object|null,
 *   onClose: () => void,
 *   onSaved?: () => void,
 * }} props
 */
export default function PhotoEditModal({ open, photo, onClose, onSaved }) {
  const canvasRef = useRef(/** @type {HTMLCanvasElement|null} */ (null));
  const imgRef = useRef(/** @type {HTMLImageElement|null} */ (null));
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [saving, setSaving] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rad = ((rotation % 360) * Math.PI) / 180;
    const swapped = rotation % 180 !== 0;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const cw = swapped ? ih : iw;
    const ch = swapped ? iw : ih;
    const max = 720;
    const scale = Math.min(1, max / Math.max(cw, ch));
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
    ctx.restore();
  }, [rotation]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset editor state when a photo is opened
    setRotation(0);
    setError(null);
  }, [open, photo?.path]);

  useEffect(() => {
    if (!open || !photo) return undefined;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      paint();
    };
    img.onerror = () => setError("Luna couldn't load this photo for editing.");
    img.src = contentHref(photo.drive_id, photo.path);
    return undefined;
  }, [open, photo, paint]);

  async function save() {
    if (!photo) return;
    setSaving(true);
    setError(null);
    try {
      // Prefer dedicated edit endpoint when the parallel backend agent adds it.
      try {
        await postJson("/api/v1/gallery/edit", {
          drive_id: photo.drive_id,
          path: photo.path,
          rotate: rotation % 360,
        });
        onSaved?.();
        onClose();
        return;
      } catch (err) {
        if (err?.status && err.status !== 404) throw err;
        // Fall through to client canvas export.
      }

      const img = imgRef.current;
      if (!img) throw new Error("missing image");
      const rad = ((rotation % 360) * Math.PI) / 180;
      const swapped = rotation % 180 !== 0;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const cw = swapped ? ih : iw;
      const ch = swapped ? iw : ih;
      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -iw / 2, -ih / 2);
      const blob = await new Promise((resolve, reject) => {
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92);
      });
      const base = (photo.name || "photo").replace(/\.[^.]+$/, "");
      const folder = (photo.path || "").split("/").slice(0, -1).join("/");
      const form = new FormData();
      form.append("file", blob, `${base}-edited.jpg`);
      await postForm(
        `/api/v1/drives/${photo.drive_id}/files/upload?path=${encodeURIComponent(folder)}`,
        form,
      );
      onSaved?.();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Luna couldn't save the edited photo. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalCard
      open={open}
      title="Rotate photo"
      onClose={onClose}
      overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
    >
      {({ close }) => (
        <div className="space-y-4">
          <ModalErrorNotice error={error} />
          <div className="rounded-large-element bg-primary text-secondary overflow-hidden">
            <canvas
              ref={canvasRef}
              className="mx-auto max-h-80 w-full object-contain"
            />
          </div>
          <p className="text-sm">Luna saves a rotated copy next to the original.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setRotation((r) => (r + 90) % 360)}>
              Rotate 90°
            </Button>
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="button" variant="accent" loading={saving} onClick={save}>
              Save copy
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

PhotoEditModal.propTypes = {
  open: PropTypes.bool.isRequired,
  photo: PropTypes.object,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
};
