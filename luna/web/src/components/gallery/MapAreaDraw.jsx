/* eslint-disable react-refresh/only-export-components -- exports bbox helpers */
import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Rectangle, useMap } from "react-leaflet";
import { haptic } from "../../utils/haptics.js";

/**
 * @param {[number, number, number, number]|null|undefined} bbox west,south,east,north
 * @returns {[[number, number], [number, number]]|null}
 */
export function bboxToBounds(bbox) {
  if (!bbox || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every((n) => Number.isFinite(n))) return null;
  return [
    [south, west],
    [north, east],
  ];
}

/**
 * @param {[[number, number], [number, number]]} bounds
 * @returns {[number, number, number, number]}
 */
export function boundsToBbox(bounds) {
  const [[s1, w1], [s2, w2]] = bounds;
  return [
    Math.min(w1, w2),
    Math.min(s1, s2),
    Math.max(w1, w2),
    Math.max(s1, s2),
  ];
}

/**
 * Interactive bounding box drawing overlay on Leaflet maps.
 * Handles desktop mouse, mobile touch, and stylus via Pointer Events with pointer capture.
 * Disables map dragging and touch scrolling while draw mode is active.
 *
 * @param {{
 *   active?: boolean,
 *   value?: [number, number, number, number]|null,
 *   onChange?: (bbox: [number, number, number, number]|null) => void,
 *   onDraftChange?: (bbox: [number, number, number, number]|null) => void,
 * }} props
 */
export default function MapAreaDraw({
  active = true,
  value = null,
  onChange,
  onDraftChange,
}) {
  const map = useMap();
  const [draft, setDraft] = useState(/** @type {[[number, number], [number, number]]|null} */ (null));
  const isDrawingRef = useRef(false);
  const originRef = useRef(/** @type {[number, number]|null} */ (null));

  useEffect(() => {
    if (!active) return undefined;
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    const container = map.getContainer();
    const prevCursor = container.style.cursor;
    const prevTouchAction = container.style.touchAction;
    container.style.cursor = "crosshair";
    container.style.touchAction = "none";

    return () => {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      container.style.cursor = prevCursor;
      container.style.touchAction = prevTouchAction;
    };
  }, [map, active]);

  useEffect(() => {
    if (!active) return undefined;
    const container = map.getContainer();

    const handlePointerDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest?.(".leaflet-control")) return;
      if (e.target.closest?.("[data-draw-ignore]")) return;

      e.preventDefault();
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture may fail on synthetic test events; ignore safely.
      }

      const latlng = map.mouseEventToLatLng(e);
      /** @type {[number, number]} */
      const start = [latlng.lat, latlng.lng];
      originRef.current = start;
      isDrawingRef.current = true;
      setDraft([start, start]);
    };

    const handlePointerMove = (e) => {
      if (!isDrawingRef.current || !originRef.current) return;
      e.preventDefault();
      const latlng = map.mouseEventToLatLng(e);
      /** @type {[number, number]} */
      const current = [latlng.lat, latlng.lng];
      setDraft([originRef.current, current]);
      if (onDraftChange) {
        onDraftChange(
          boundsToBbox(/** @type {[[number, number], [number, number]]} */ ([originRef.current, current])),
        );
      }
    };

    const finishDraw = (e) => {
      if (!isDrawingRef.current || !originRef.current) return;
      isDrawingRef.current = false;
      e.preventDefault();
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture release may fail on synthetic test events; ignore safely.
      }

      const latlng = map.mouseEventToLatLng(e);
      /** @type {[number, number]} */
      const end = [latlng.lat, latlng.lng];
      /** @type {[[number, number], [number, number]]} */
      const next = [originRef.current, end];
      originRef.current = null;
      setDraft(null);

      const bbox = boundsToBbox(next);
      const tiny =
        Math.abs(bbox[2] - bbox[0]) < 0.0001 && Math.abs(bbox[3] - bbox[1]) < 0.0001;
      if (!tiny) {
        haptic("medium");
        onChange?.(bbox);
      }
    };

    const cancelDraw = (e) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      originRef.current = null;
      setDraft(null);
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        // ignore safely
      }
    };

    container.addEventListener("pointerdown", handlePointerDown, { passive: false });
    container.addEventListener("pointermove", handlePointerMove, { passive: false });
    container.addEventListener("pointerup", finishDraw, { passive: false });
    container.addEventListener("pointercancel", cancelDraw, { passive: false });

    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerup", finishDraw);
      container.removeEventListener("pointercancel", cancelDraw);
    };
  }, [map, active, onChange, onDraftChange]);

  const shown = draft || bboxToBounds(value);
  if (!shown) return null;

  return (
    <Rectangle
      bounds={shown}
      pathOptions={{
        color: "var(--color-secondary)",
        weight: 2,
        fillColor: "var(--color-accent)",
        fillOpacity: 0.25,
      }}
    />
  );
}

MapAreaDraw.propTypes = {
  active: PropTypes.bool,
  value: PropTypes.arrayOf(PropTypes.number),
  onChange: PropTypes.func,
  onDraftChange: PropTypes.func,
};
