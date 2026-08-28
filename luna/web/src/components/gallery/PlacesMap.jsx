import { useEffect, useMemo } from "react";
import PropTypes from "prop-types";
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
        className="h-full w-full [&_.leaflet-control-attribution]:text-[10px]"
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
            <Popup>
              <div className="text-sm space-y-2 min-w-[140px]">
                <p className="font-mono">{place.label}</p>
                <p>
                  {place.count} {place.count === 1 ? "photo" : "photos"}
                </p>
                <Button variant="accent" size="sm" onClick={() => onSelect?.(place)}>
                  Open
                </Button>
              </div>
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
