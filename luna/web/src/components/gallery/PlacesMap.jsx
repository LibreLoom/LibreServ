import { useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { ImageIcon } from "lucide-react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "../ui/Button.jsx";

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

function PlacePopupContent({ place, onSelect }) {
  const photoWord = place.count === 1 ? "photo" : "photos";

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
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate font-mono text-xs leading-tight">{place.label}</p>
            <span
              className="shrink-0 rounded-pill bg-accent px-1.5 py-0.5 font-mono text-[10px] leading-none text-primary"
              aria-label={`${place.count} ${photoWord}`}
            >
              {place.count}
            </span>
          </div>
        </div>

        <Button
          variant="primary"
          size="sm"
          className="shrink-0 px-3"
          onClick={() => onSelect?.(place)}
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

/** Full-bleed Leaflet Places map (OSM tiles in the browser only). */
export default function PlacesMap({ places, onSelect }) {
  const points = useMemo(
    () => (places || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    [places],
  );

  if (!points.length) {
    return (
      <div className="rounded-large-element bg-secondary text-primary p-8 text-center">
        <p className="font-mono text-sm">No places yet</p>
        <p className="mt-2 text-sm">
          When photos include a location from the camera, they show up here on the map.
        </p>
      </div>
    );
  }

  const center = [points[0].lat, points[0].lon];

  return (
    <div className="overflow-hidden rounded-large-element border-2 border-secondary/30 h-[min(70vh,640px)] bg-secondary text-primary">
      <MapContainer
        center={center}
        zoom={4}
        className="places-map h-full w-full [&_.leaflet-control-attribution]:text-[10px]"
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {points.map((place) => (
          <CircleMarker
            key={place.key}
            center={[place.lat, place.lon]}
            radius={Math.min(18, 8 + Math.log2(place.count + 1) * 3)}
            pathOptions={{
              color: "var(--secondary)",
              fillColor: "var(--accent)",
              fillOpacity: 0.85,
              weight: 2,
            }}
          >
            <Popup className="places-map-popup" minWidth={0} maxWidth={280}>
              <PlacePopupContent place={place} onSelect={onSelect} />
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}

PlacesMap.propTypes = {
  places: PropTypes.arrayOf(PropTypes.object),
  onSelect: PropTypes.func,
};
