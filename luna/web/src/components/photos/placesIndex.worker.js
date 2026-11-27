import { buildPlacesIndex, clusterToPlace } from "./placesIndex.js";

let index;
self.onmessage = ({ data }) => {
  const { id, operation, args } = data;
  try {
    if (operation === "build") {
      index = buildPlacesIndex(args[0]);
      self.postMessage({ id });
      return;
    }
    let value;
    switch (operation) {
      case "clusters":
        value = index.getClusters(args[0], args[1]);
        break;
      case "place":
        value = clusterToPlace(args[0], index);
        break;
      case "expansionZoom":
        value = index.getClusterExpansionZoom(args[0]);
        break;
      default:
        throw new Error("Unknown Places index operation");
    }
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
