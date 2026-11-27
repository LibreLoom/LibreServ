import Supercluster from "supercluster";

/** @param {Array<any>} markers */
export function buildPlacesIndex(markers) {
  const index = new Supercluster({ radius: 56, maxZoom: 18, minZoom: 0, minPoints: 2 });
  index.load(markers.map((marker) => ({
    type: "Feature",
    properties: {
      key: marker.key,
      id: marker.id || `${marker.lat},${marker.lon}`,
      label: marker.label,
      cover_thumb: marker.cover_thumb || "",
    },
    geometry: { type: "Point", coordinates: [marker.lon, marker.lat] },
  })));
  return index;
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
export function clusterToPlace(cluster, index) {
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
