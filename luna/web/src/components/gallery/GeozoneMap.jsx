/* eslint-disable react-refresh/only-export-components -- map exports bbox helpers used by GalleryFilterSheet */
import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Rectangle,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "../ui/Button.jsx";

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

function FitPlaces({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) {
      map.setView([20, 0], 2);
      return;
    }
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 8);
      return;
    }
    map.fitBounds(
      points.map((p) => [p.lat, p.lon]),
      { padding: [24, 24], maxZoom: 10 },
    );
  }, [map, points]);
  return null;
}

function FitBbox({ bbox }) {
  const map = useMap();
  useEffect(() => {
    const bounds = bboxToBounds(bbox);
    if (!bounds) return;
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
  }, [map, bbox]);
  return null;
}

function DrawRectangle({ value, onChange }) {
  const [draft, setDraft] = useState(/** @type {[[number,number],[number,number]]|null} */ (null));
  const [origin, setOrigin] = useState(/** @type {[number, number]|null} */ (null));

  useMapEvents({
    mousedown(e) {
      if (e.originalEvent?.button != null && e.originalEvent.button !== 0) return;
      // Avoid starting a draw while interacting with controls.
      const t = e.originalEvent?.target;
      if (t instanceof Element && t.closest(".leaflet-control")) return;
      setOrigin([e.latlng.lat, e.latlng.lng]);
      setDraft([
        [e.latlng.lat, e.latlng.lng],
        [e.latlng.lat, e.latlng.lng],
      ]);
    },
    mousemove(e) {
      if (!origin) return;
      setDraft([origin, [e.latlng.lat, e.latlng.lng]]);
    },
    mouseup(e) {
      if (!origin) return;
      const next = [origin, [e.latlng.lat, e.latlng.lng]];
      setOrigin(null);
      setDraft(null);
      const bbox = boundsToBbox(/** @type {[[number, number], [number, number]]} */ (next));
      const tiny =
        Math.abs(bbox[2] - bbox[0]) < 0.00005 && Math.abs(bbox[3] - bbox[1]) < 0.00005;
      if (tiny) return;
      onChange?.(bbox);
    },
  });

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

/**
 * Leaflet map for drawing a geographic filter zone (bounding box).
 *
 * @param {{
 *   places?: Array<{ lat: number, lon: number, key?: string, label?: string }>,
 *   value?: [number, number, number, number]|null,
 *   onChange?: (bbox: [number, number, number, number]|null) => void,
 *   className?: string,
 *   height?: string,
 * }} props
 */
export default function GeozoneMap({
  places = [],
  value = null,
  onChange,
  className = "",
  height = "14rem",
}) {
  const points = useMemo(
    () =>
      (places || []).filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
      ),
    [places],
  );

  const summary = useCallback(() => {
    if (!value) return null;
    const [west, south, east, north] = value;
    return `${south.toFixed(2)}–${north.toFixed(2)} lat · ${west.toFixed(2)}–${east.toFixed(2)} lon`;
  }, [value]);

  return (
    <div className={className} data-slot="geozone-map">
      <p className="mb-2 text-sm">Drag on the map to choose an area.</p>
      <div
        className="overflow-hidden rounded-large-element border-2 border-secondary/30 bg-primary text-secondary"
        style={{ height }}
      >
        <MapContainer
          center={[20, 0]}
          zoom={2}
          className="h-full w-full"
          scrollWheelZoom
          attributionControl={false}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          {!value && <FitPlaces points={points} />}
          {value && <FitBbox bbox={value} />}
          {points.slice(0, 200).map((p) => (
            <CircleMarker
              key={p.key || `${p.lat},${p.lon}`}
              center={[p.lat, p.lon]}
              radius={4}
              pathOptions={{
                color: "var(--color-secondary)",
                fillColor: "var(--color-accent)",
                fillOpacity: 0.8,
                weight: 1,
              }}
            />
          ))}
          <DrawRectangle value={value} onChange={onChange} />
        </MapContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-mono">
          {value ? summary() : "No area selected"}
        </p>
        {value && (
          <Button type="button" size="sm" variant="outline" onClick={() => onChange?.(null)}>
            Clear zone
          </Button>
        )}
      </div>
    </div>
  );
}

GeozoneMap.propTypes = {
  places: PropTypes.arrayOf(
    PropTypes.shape({
      lat: PropTypes.number.isRequired,
      lon: PropTypes.number.isRequired,
      key: PropTypes.string,
      label: PropTypes.string,
    }),
  ),
  value: PropTypes.arrayOf(PropTypes.number),
  onChange: PropTypes.func,
  className: PropTypes.string,
  height: PropTypes.string,
};
