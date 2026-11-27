import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Check, Crop, ImageIcon, MapPin, Pencil, X } from "lucide-react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Tooltip,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useSmoothResize } from "@libreloom/ui/hooks/useSmoothResize.js";
import MapAreaDraw, { bboxToBounds } from "./MapAreaDraw.jsx";
import { usePlacesIndex } from "./usePlacesIndex.js";

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 10);
      return;
    }
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const { lat, lon } of points) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    }
    const bounds = bboxToBounds([west, south, east, north]);
    if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }, [map, points]);
  return null;
}

/** Esc dismisses an open place popup and cancels an in-progress area draw. */
function EscapeDismiss({ onCancel }) {
  const map = useMap();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      map.closePopup?.();
      onCancel?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [map, onCancel]);
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

export function PlacePopupContent({ place, onSelect }) {
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
    <div className="places-map-popup-card surface-secondary rounded-large-element border-2 border-primary p-2 shadow-[0_8px_24px_color-mix(in_srgb,var(--color-secondary)_25%,transparent)] motion-safe:animate-[pop-in_200ms_var(--motion-easing-emphasized-decelerate)_both]">
      <div className="flex items-center gap-2">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[12px] bg-primary/20">
          {place.cover_thumb ? (
            <img
              src={place.cover_thumb}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
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
};

function ClusterMarkers({ markers, onSelect }) {
  const map = useMap();
  const [viewport, setViewport] = useState(null);

  const index = usePlacesIndex(markers);
  useEffect(() => {
    if (!index) return undefined;
    let frame = 0;
    let latest = 0;
    let lastViewport = "";
    function refresh() {
      frame = 0;
      const bounds = map.getBounds();
      const z = map.getZoom();
      /** @type {[number, number, number, number]} */
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      const key = `${bbox.join(",")}:${z}`;
      if (key === lastViewport) return;
      lastViewport = key;
      const serial = ++latest;
      const result = index.clusters(bbox, Math.floor(z));
      if (Array.isArray(result)) {
        setViewport({ index, zoom: z, clusters: result });
      } else {
        result.then((next) => {
          if (serial !== latest) return;
          setViewport({ index, zoom: z, clusters: next });
        }).catch(() => {});
      }
    }
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(refresh);
    }
    map.on?.("moveend zoomend", schedule);
    refresh();
    return () => {
      latest++;
      if (frame) window.cancelAnimationFrame(frame);
      map.off?.("moveend zoomend", schedule);
    };
  }, [index, map]);

  return (
    <>
      {viewport && viewport.index === index && viewport.clusters.map((cluster) => {
        const isCluster = Boolean(cluster.properties.cluster);
        return (
          <ClusterMarker
            key={isCluster ? `cluster-${cluster.id}` : cluster.properties.id}
            cluster={cluster}
            index={index}
            zoom={viewport.zoom}
            onSelect={onSelect}
          />
        );
      })}
    </>
  );
}

/**
 * One map dot. Memoized so panning only redraws the dots that changed, and the
 * popup's place (which walks every photo in a cluster) is built when the popup
 * opens, not for every dot on every move.
 */
const ClusterMarker = memo(
  /** @param {{ cluster: any, index: ReturnType<typeof usePlacesIndex>, zoom: number, onSelect?: (place: any) => void }} props */
  function ClusterMarker({ cluster, index, zoom, onSelect }) {
    const map = useMap();
    const popupRef = useRef(/** @type {import("leaflet").Popup|null} */ (null));
    const [popupOpen, setPopupOpen] = useState(false);
    const [lon, lat] = cluster.geometry.coordinates;
    const isCluster = Boolean(cluster.properties.cluster);
    const count = isCluster ? cluster.properties.point_count : 1;
    const radius = clusterRadius(count, zoom);
    const [loadedPlace, setLoadedPlace] = useState(null);
    useEffect(() => {
      if (!popupOpen) return undefined;
      let cancelled = false;
      Promise.resolve(index.place(cluster)).then((place) => {
        if (!cancelled) setLoadedPlace({ cluster, index, place });
      }).catch(() => {});
      return () => { cancelled = true; };
    }, [popupOpen, cluster, index]);
    const place = popupOpen && loadedPlace?.cluster === cluster && loadedPlace.index === index
      ? loadedPlace.place : null;

    // The popup was measured while empty; re-measure once its content exists.
    useEffect(() => {
      if (place) popupRef.current?.update();
    }, [place]);

    return (
      <CircleMarker
        center={[lat, lon]}
        radius={radius}
        eventHandlers={{
          click: () => {
            haptic("selection");
          },
          dblclick: (e) => {
            if (!isCluster) return;
            e.originalEvent?.preventDefault?.();
            haptic("medium");
            Promise.resolve(index.expansionZoom(cluster.id)).then((nextZoom) => {
              map.setView([lat, lon], Math.min(nextZoom, 18), { animate: true });
            }).catch(() => {});
          },
          popupopen: () => setPopupOpen(true),
          popupclose: () => setPopupOpen(false),
        }}
        pathOptions={{
          color: "var(--primary)",
          fillColor: "var(--secondary)",
          fillOpacity: 1,
          weight: isCluster ? 3 : 2.5,
        }}
      >
        {isCluster && count > 1 && (
          <Tooltip permanent direction="center" className="places-map-cluster-count" offset={[0, 0]}>
            {count}
          </Tooltip>
        )}
        <Popup ref={popupRef} className="places-map-popup" closeButton={false} minWidth={0} maxWidth={280}>
          {place ? <PlacePopupContent place={place} onSelect={onSelect} /> : null}
        </Popup>
      </CircleMarker>
    );
  },
  (prev, next) =>
    prev.index === next.index &&
    prev.zoom === next.zoom &&
    prev.onSelect === next.onSelect &&
    prev.cluster.id === next.cluster.id &&
    prev.cluster.properties.point_count === next.cluster.properties.point_count &&
    prev.cluster.geometry.coordinates[0] === next.cluster.geometry.coordinates[0] &&
    prev.cluster.geometry.coordinates[1] === next.cluster.geometry.coordinates[1],
);

ClusterMarkers.propTypes = {
  markers: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSelect: PropTypes.func,
};

/**
 * Full-bleed Leaflet Places map with zoom-based photo clustering and on-map custom area drawing.
 *
 * @param {{
 *   places?: Array<any>,
 *   loading?: boolean,
 *   filtered?: boolean,
 *   onSelect?: (place: any) => void,
 *   onDrawArea?: () => void,
 *   drawMode?: boolean,
 *   onDrawModeChange?: (active: boolean) => void,
 * }} props
 */
export default function PlacesMap({
  places,
  loading = false,
  filtered = false,
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

  // The draw control is ONE pill pinned top-right: a 40px pencil circle at
  // rest, resizing in place to fit the draw instructions/actions when active.
  // X only — the pill's height is fixed, content scrolls instead of wrapping.
  const drawCtlRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  useSmoothResize(drawCtlRef);

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

  const handleCancelDraw = useCallback(() => {
    if (!isDrawMode) return;
    haptic("light");
    setDrawMode(false);
    setDrawnBbox(null);
  }, [isDrawMode, setDrawMode]);

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

  // With filters on, no matches is just an empty map, not an empty state.
  if (!markers.length && !filtered) {
    return (
      <EmptyState
        noPopIn
        className="animate-cascade-in motion-reduce:animate-none"
        icon={MapPin}
        title="No places yet"
        description="Photos with a location from the phone or camera show here on the map."
      />
    );
  }

  /** @type {[number, number]} */
  const center = markers.length ? [markers[0].lat, markers[0].lon] : [20, 0];

  return (
    <Card
      noHeightAnim
      noPopIn
      padding={false}
      className="animate-cascade-in motion-reduce:animate-none @container relative isolate flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-secondary/30"
    >
      {/* Draw control — one corner pill that resizes to fit its content. */}
      <div
        ref={drawCtlRef}
        className="absolute top-3 right-3 z-[1000] flex max-w-[calc(100%-1.5rem)] items-center overflow-hidden rounded-pill surface-secondary shadow-xl ring-2 ring-accent"
      >
        {!isDrawMode ? (
          <button
            key="idle"
            type="button"
            aria-label="Draw a custom area"
            title="Draw a custom area"
            onClick={handleStartDraw}
            className="pop-in flex h-10 w-10 shrink-0 items-center justify-center rounded-pill motion-safe:transition-colors hover:bg-primary hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
        ) : !drawnBbox ? (
          <div
            key="draw"
            className="pop-in flex flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap px-3.5 py-2 text-xs font-mono no-scrollbar"
          >
            <Crop size={15} className="shrink-0 animate-pulse" aria-hidden="true" />
            <span>Draw custom area</span>
            <span className="hidden @md:inline">· Drag across the map</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Cancel"
              title="Cancel"
              className="ml-1 h-6 px-2 text-xs rounded-pill"
              onClick={() => {
                haptic("light");
                setDrawMode(false);
                setDrawnBbox(null);
              }}
            >
              <span className="hidden @sm:inline">Cancel</span>
              <X size={14} className="@sm:hidden" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div
            key="drawn"
            className="pop-in flex flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap px-3.5 py-2 text-xs font-mono no-scrollbar"
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill surface-primary"
              aria-hidden="true"
            >
              <Check size={12} strokeWidth={3} />
            </span>
            <span>
              {matchedCount === 0
                ? "No photos"
                : `${matchedCount} ${matchedCount === 1 ? "photo" : "photos"}`}
              <span className="hidden @sm:inline"> in area</span>
            </span>
            <span className="hidden @xl:inline">· Drag again to adjust</span>
            {matchedCount > 0 && (
              <Button
                type="button"
                size="sm"
                aria-label="Open photos"
                className="h-6 shrink-0 px-3 text-xs rounded-pill"
                onClick={() => {
                  haptic("medium");
                  onSelect?.({
                    key: `bbox:${drawnBbox.map((n) => n.toFixed(5)).join(",")}`,
                    label: "Custom area",
                    count: matchedCount,
                    place_bbox: drawnBbox,
                    drawn: true,
                  });
                  setDrawMode(false);
                  setDrawnBbox(null);
                }}
              >
                <span className="@sm:hidden">Open</span>
                <span className="hidden @sm:inline">Open photos</span>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Cancel"
              title="Cancel"
              className="h-6 shrink-0 px-2 text-xs rounded-pill"
              onClick={() => {
                haptic("light");
                setDrawMode(false);
                setDrawnBbox(null);
              }}
            >
              <span className="hidden @sm:inline">Cancel</span>
              <X size={14} className="@sm:hidden" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      <MapContainer
        center={center}
        zoom={markers.length ? 4 : 2}
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
        <EscapeDismiss onCancel={handleCancelDraw} />
        <ClusterMarkers markers={markers} onSelect={onSelect} />
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
  filtered: PropTypes.bool,
  onSelect: PropTypes.func,
  onDrawArea: PropTypes.func,
  drawMode: PropTypes.bool,
  onDrawModeChange: PropTypes.func,
};
