import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Crop, ImageIcon, MapPin } from "lucide-react";
import Supercluster from "supercluster";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "../ui/Button.jsx";
import Card from "../cards/Card.jsx";
import EmptyState from "../common/EmptyState.jsx";
import Spinner from "../ui/Spinner.jsx";
import { haptic } from "../../utils/haptics.js";
import MapAreaDraw from "./MapAreaDraw.jsx";

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 10);
      return;
    }
    const bounds = points.map((p) => [p.lat, p.lon]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }, [map, points]);
  return null;
}

/** Leaflet needs invalidateSize when a flex parent settles the map height. */
function InvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer?.();
    const refresh = () => {
      map.invalidateSize?.();
    };
    refresh();
    if (!container || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(refresh);
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function clusterRadius(count, zoom) {
  const base = 8 + Math.log2(count + 1) * 3.5;
  const zoomScale = Math.max(0.75, 1.15 - zoom * 0.03);
  return Math.min(34, base * zoomScale);
}

function dominantLabel(leaves) {
  const counts = new Map();
  for (const leaf of leaves) {
    const label = leaf.properties.label;
    if (!label || label === "Photos from this place") continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [label, n] of counts) {
    if (n > bestCount) {
      best = label;
      bestCount = n;
    }
  }
  return best;
}

function bboxFromLeaves(leaves) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const leaf of leaves) {
    const [lon, lat] = leaf.geometry.coordinates;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  const pad = 0.0002;
  return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];
}

/** @param {import('supercluster').AnyProps} cluster @param {Supercluster} index */
function clusterToPlace(cluster, index) {
  const [lon, lat] = cluster.geometry.coordinates;
  const props = cluster.properties;

  if (props.cluster) {
    const count = props.point_count;
    const leaves = index.getLeaves(cluster.id, Infinity);
    const bbox = bboxFromLeaves(leaves);
    const cover =
      leaves.find((leaf) => leaf.properties.cover_thumb)?.properties.cover_thumb || "";
    const label = dominantLabel(leaves) || (count === 1 ? "1 photo" : `${count} photos`);
    return {
      key: `bbox:${bbox.map((n) => n.toFixed(5)).join(",")}`,
      label,
      count,
      lat,
      lon,
      cover_thumb: cover,
      place_bbox: bbox,
    };
  }

  const pad = 0.00005;
  return {
    key: props.key,
    label: props.label,
    count: 1,
    lat,
    lon,
    cover_thumb: props.cover_thumb || "",
    place_bbox: [lon - pad, lat - pad, lon + pad, lat + pad],
  };
}

export function PlacePopupContent({ place, onSelect, onDrawArea = undefined }) {
  const photoWord = place.count === 1 ? "photo" : "photos";
  const countText = `${place.count} ${photoWord}`;
  // Clustering may already set label to "N photos"; avoid showing that twice.
  const placeName =
    place.label &&
    place.label !== countText &&
    place.label !== "Photos from this place"
      ? place.label
      : null;

  return (
    <div className="places-map-popup-card bg-secondary text-primary rounded-large-element border-2 border-primary p-2 shadow-[0_8px_24px_color-mix(in_srgb,var(--color-secondary)_25%,transparent)] motion-safe:animate-[pop-in_200ms_var(--motion-easing-emphasized-decelerate)_both]">
      <div className="flex items-center gap-2">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[12px] bg-accent">
          {place.cover_thumb ? (
            <img
              src={place.cover_thumb}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-primary">
              <ImageIcon className="h-4 w-4" aria-hidden />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {placeName ? (
            <>
              <p className="truncate font-mono text-xs leading-tight">{placeName}</p>
              <p className="truncate text-[11px] leading-tight">{countText}</p>
            </>
          ) : (
            <p className="truncate font-mono text-xs leading-tight">{countText}</p>
          )}
        </div>

        <Button
          variant="primary"
          size="sm"
          className="shrink-0 px-3"
          onClick={() => {
            haptic("medium");
            onSelect?.(place);
          }}
        >
          Open
        </Button>
      </div>
      {onDrawArea && (
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => {
              haptic("light");
              onDrawArea();
            }}
          >
            Draw a custom area…
          </Button>
        </div>
      )}
    </div>
  );
}

PlacePopupContent.propTypes = {
  place: PropTypes.shape({
    key: PropTypes.string,
    label: PropTypes.string,
    count: PropTypes.number,
    cover_thumb: PropTypes.string,
  }).isRequired,
  onSelect: PropTypes.func,
  onDrawArea: PropTypes.func,
};

function ClusterMarkers({ markers, onSelect, onDrawArea = undefined }) {
  const map = useMap();
  const [clusters, setClusters] = useState([]);
  const [zoom, setZoom] = useState(() => map.getZoom());

  const index = useMemo(() => {
    const sc = new Supercluster({
      radius: 56,
      maxZoom: 18,
      minZoom: 0,
      minPoints: 2,
    });
    sc.load(
      markers.map((m) => ({
        type: "Feature",
        properties: {
          key: m.key,
          id: m.id || `${m.lat},${m.lon}`,
          label: m.label,
          cover_thumb: m.cover_thumb || "",
        },
        geometry: { type: "Point", coordinates: [m.lon, m.lat] },
      })),
    );
    return sc;
  }, [markers]);

  const refreshClusters = useCallback(() => {
    const bounds = map.getBounds();
    const z = map.getZoom();
    setZoom(z);
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    setClusters(index.getClusters(bbox, Math.floor(z)));
  }, [index, map]);

  useMapEvents({
    moveend: refreshClusters,
    zoomend: refreshClusters,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
    refreshClusters();
  }, [refreshClusters]);

  return (
    <>
      {clusters.map((cluster) => {
        const [lon, lat] = cluster.geometry.coordinates;
        const isCluster = Boolean(cluster.properties.cluster);
        const count = isCluster ? cluster.properties.point_count : 1;
        const radius = clusterRadius(count, zoom);
        const place = clusterToPlace(cluster, index);
        const markerKey = isCluster ? `cluster-${cluster.id}` : cluster.properties.id;

        const expandZoom = isCluster
          ? Math.min(index.getClusterExpansionZoom(cluster.id), 18)
          : null;

        return (
          <CircleMarker
            key={markerKey}
            center={[lat, lon]}
            radius={radius}
            eventHandlers={{
              click: () => {
                haptic("selection");
              },
              dblclick: (e) => {
                if (!isCluster || expandZoom == null) return;
                e.originalEvent?.preventDefault?.();
                haptic("medium");
                map.setView([lat, lon], expandZoom, { animate: true });
              },
            }}
            pathOptions={{
              color: "var(--secondary)",
              fillColor: isCluster ? "var(--accent)" : "var(--secondary)",
              fillOpacity: isCluster ? 0.9 : 0.75,
              weight: isCluster ? 2.5 : 2,
            }}
          >
            {isCluster && count > 1 && (
              <Tooltip
                permanent
                direction="center"
                className="places-map-cluster-count"
                offset={[0, 0]}
              >
                {count}
              </Tooltip>
            )}
            <Popup
              className="places-map-popup"
              closeButton={false}
              minWidth={0}
              maxWidth={280}
            >
              <PlacePopupContent place={place} onSelect={onSelect} onDrawArea={onDrawArea} />
            </Popup>
          </CircleMarker>
        );
      })}
    </>
  );
}

ClusterMarkers.propTypes = {
  markers: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSelect: PropTypes.func,
  onDrawArea: PropTypes.func,
};

/**
 * Full-bleed Leaflet Places map with zoom-based photo clustering and on-map custom area drawing.
 *
 * @param {{
 *   places?: Array<any>,
 *   loading?: boolean,
 *   onSelect?: (place: any) => void,
 *   onDrawArea?: () => void,
 *   drawMode?: boolean,
 *   onDrawModeChange?: (active: boolean) => void,
 * }} props
 */
export default function PlacesMap({
  places,
  loading = false,
  onSelect,
  onDrawArea = undefined,
  drawMode: drawModeProp = undefined,
  onDrawModeChange = undefined,
}) {
  const [internalDrawMode, setInternalDrawMode] = useState(false);
  const isDrawMode = drawModeProp !== undefined ? drawModeProp : internalDrawMode;
  const setDrawMode = useCallback(
    (val) => {
      if (onDrawModeChange) onDrawModeChange(val);
      else setInternalDrawMode(val);
    },
    [onDrawModeChange],
  );

  const [drawnBbox, setDrawnBbox] = useState(/** @type {[number, number, number, number]|null} */ (null));

  const markers = useMemo(
    () => (places || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    [places],
  );

  const matchedCount = useMemo(() => {
    if (!drawnBbox) return 0;
    const [west, south, east, north] = drawnBbox;
    let total = 0;
    for (const m of markers) {
      if (m.lon >= west && m.lon <= east && m.lat >= south && m.lat <= north) {
        total += m.count || 1;
      }
    }
    return total;
  }, [drawnBbox, markers]);

  const handleStartDraw = useCallback(() => {
    haptic("light");
    setDrawMode(true);
    setDrawnBbox(null);
    onDrawArea?.();
  }, [setDrawMode, onDrawArea]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-3 py-20 text-secondary"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-mono">Loading places…</p>
        <Spinner size="lg" decorative className="text-secondary" />
      </div>
    );
  }

  if (!markers.length) {
    return (
      <EmptyState
        icon={MapPin}
        title="No places yet"
        description="When photos include a location from the camera, they show up here on the map."
      />
    );
  }

  /** @type {[number, number]} */
  const center = [markers[0].lat, markers[0].lon];

  return (
    <Card
      noHeightAnim
      padding={false}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-secondary/30"
    >
      {/* Floating Draw Mode Toolbar */}
      {isDrawMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] max-w-[calc(100%-1.5rem)] pointer-events-auto">
          {!drawnBbox ? (
            <div className="flex items-center gap-2 bg-secondary text-primary px-3.5 py-2 rounded-pill shadow-xl ring-2 ring-accent text-xs font-mono animate-nav-slide-in">
              <Crop size={15} className="shrink-0 text-accent animate-pulse" aria-hidden="true" />
              <span className="font-medium">Draw custom area</span>
              <span className="text-accent hidden sm:inline">· Drag across the map</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-1 h-6 px-2 text-xs rounded-pill"
                onClick={() => {
                  haptic("light");
                  setDrawMode(false);
                  setDrawnBbox(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-2 bg-secondary text-primary px-3.5 py-2 rounded-pill shadow-xl ring-2 ring-accent text-xs font-mono animate-nav-slide-in">
              <span className="font-medium">
                {matchedCount === 0
                  ? "No photos in area"
                  : `${matchedCount} ${matchedCount === 1 ? "photo" : "photos"} in area`}
              </span>
              {matchedCount > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  className="h-7 px-3 text-xs rounded-pill"
                  onClick={() => {
                    haptic("medium");
                    onSelect?.({
                      key: `bbox:${drawnBbox.map((n) => n.toFixed(5)).join(",")}`,
                      label: "Custom area",
                      count: matchedCount,
                      place_bbox: drawnBbox,
                    });
                    setDrawMode(false);
                    setDrawnBbox(null);
                  }}
                >
                  Open photos
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs rounded-pill"
                onClick={() => {
                  haptic("selection");
                  setDrawnBbox(null);
                }}
              >
                Redraw
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs rounded-pill"
                onClick={() => {
                  haptic("light");
                  setDrawMode(false);
                  setDrawnBbox(null);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      <MapContainer
        center={center}
        zoom={4}
        className="places-map min-h-0 h-full w-full flex-1 [&_.leaflet-control-attribution]:text-[10px]"
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          referrerPolicy="strict-origin-when-cross-origin"
          maxZoom={19}
        />
        <InvalidateOnResize />
        <FitBounds points={markers} />
        <ClusterMarkers markers={markers} onSelect={onSelect} onDrawArea={handleStartDraw} />
        <MapAreaDraw
          active={isDrawMode}
          value={drawnBbox}
          onChange={(bbox) => {
            setDrawnBbox(bbox);
          }}
        />
      </MapContainer>
    </Card>
  );
}

PlacesMap.propTypes = {
  places: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  onSelect: PropTypes.func,
  onDrawArea: PropTypes.func,
  drawMode: PropTypes.bool,
  onDrawModeChange: PropTypes.func,
};
