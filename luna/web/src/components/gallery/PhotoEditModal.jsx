import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import { ABOVE_LIGHTBOX_OVERLAY_CLASS } from "./PhotoLightbox.jsx";
import { contentHref } from "../../lib/paths.js";
import { apiErrorMessage, postForm, postJson } from "../../lib/api";

/**
 * Minimal rotate + crop editor. Prefers POST /api/v1/gallery/edit; falls back
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
  const [crop, setCrop] = useState({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const drag = useRef(/** @type {null|{sx:number,sy:number,ox:number,oy:number}} */ (null));

  useEffect(() => {
    if (!open) return;
    setRotation(0);
    setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paint reads latest crop/rotation
  }, [open, photo?.drive_id, photo?.path, rotation, crop]);

  function paint() {
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
    // Crop overlay
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const rx = crop.x * canvas.width;
    const ry = crop.y * canvas.height;
    const rw = crop.w * canvas.width;
    const rh = crop.h * canvas.height;
    ctx.clearRect(rx, ry, rw, rh);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
    // Redraw cropped region on top
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
    ctx.restore();
  }

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
          crop,
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
      out.width = Math.max(1, Math.round(cw * crop.w));
      out.height = Math.max(1, Math.round(ch * crop.h));
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.translate(out.width / 2 - crop.x * cw + (cw * crop.w) / 2, out.height / 2 - crop.y * ch + (ch * crop.h) / 2);
      // Simpler: draw full rotated then sample crop
      const full = document.createElement("canvas");
      full.width = cw;
      full.height = ch;
      const fctx = full.getContext("2d");
      if (!fctx) throw new Error("no canvas");
      fctx.translate(cw / 2, ch / 2);
      fctx.rotate(rad);
      fctx.drawImage(img, -iw / 2, -ih / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(
        full,
        crop.x * cw,
        crop.y * ch,
        crop.w * cw,
        crop.h * ch,
        0,
        0,
        out.width,
        out.height,
      );
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
      title="Crop or rotate"
      onClose={onClose}
      overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
    >
      {({ close }) => (
        <div className="space-y-4">
          <ModalErrorNotice error={error} />
          <div className="rounded-large-element bg-primary text-secondary overflow-hidden">
            <canvas
              ref={canvasRef}
              className="mx-auto max-h-80 w-full object-contain touch-none"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                drag.current = {
                  sx: (e.clientX - rect.left) / rect.width,
                  sy: (e.clientY - rect.top) / rect.height,
                  ox: crop.x,
                  oy: crop.y,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                const dx = x - drag.current.sx;
                const dy = y - drag.current.sy;
                setCrop((c) => ({
                  ...c,
                  x: Math.min(Math.max(0, drag.current.ox + dx), 1 - c.w),
                  y: Math.min(Math.max(0, drag.current.oy + dy), 1 - c.h),
                }));
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
            />
          </div>
          <p className="text-sm">Drag to move the crop box. Luna saves a new copy next to the original.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setRotation((r) => (r + 90) % 360)}>
              Rotate 90°
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })}
            >
              Reset crop
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
