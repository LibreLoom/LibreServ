import { getJson } from "./api.js";

/** @param {string} url */
export function photosPlacesQuery(url) {
  return {
    queryKey: ["photos-places", url],
    queryFn: (/** @type {{ signal: AbortSignal }} */ { signal }) => getJson(url, { signal }),
  };
}
