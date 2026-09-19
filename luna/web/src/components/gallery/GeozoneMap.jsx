/* eslint-disable react-refresh/only-export-components -- map exports bbox helpers used by GalleryFilterSheet and tests */
import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Crop, Hand, RotateCcw } from "lucide-react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "../ui/Button.jsx";
import SegmentedControl from "../common/SegmentedControl.jsx";
import { haptic } from "../../utils/haptics.js";
import MapAreaDraw, { bboxToBounds, boundsToBbox } from "./MapAreaDraw.jsx";

export { bboxToBounds, boundsToBbox };

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

/**
 * Leaflet map for drawing a geographic filter zone (bounding box).
 * Supports both mouse and mobile touch drag drawing.
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
  height = "16rem",
}) {
  const [mode, setMode] = useState(/** @type {"pan"|"draw"} */ (value ? "pan" : "draw"));

  const points = useMemo(
    () =>
      (places || []).filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
      ),
    [places],
  );

  return (
    <div className={className} data-slot="geozone-map">
      {/* Mode toolbar */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          options={[
            { value: "pan", label: "Pan map", icon: Hand, title: "Drag to move around the map" },
            { value: "draw", label: "Draw area", icon: Crop, title: "Drag to select an area" },
          ]}
          value={mode}
          onChange={(v) => setMode(/** @type {"pan"|"draw"} */ (v))}
          surface="primary"
          aria-label="Map interaction mode"
        />
        <p className="text-xs text-accent">
          {mode === "draw"
            ? "Click & drag or drag with finger to select an area"
            : "Drag to move around the map"}
        </p>
      </div>

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
          <MapAreaDraw
            active={mode === "draw"}
            value={value}
            onChange={(bbox) => {
              onChange?.(bbox);
              setMode("pan");
            }}
          />
        </MapContainer>
      </div>

      {value && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              haptic("selection");
              setMode("draw");
            }}
          >
            <RotateCcw size={13} className="mr-1.5" aria-hidden="true" />
            Redraw
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              haptic("light");
              onChange?.(null);
              setMode("draw");
            }}
          >
            Clear zone
          </Button>
        </div>
      )}
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
