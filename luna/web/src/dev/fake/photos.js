// Builds fake photo libraries for the state gallery. Images are tiny inline SVGs
// (data: URLs), so the grid, lightbox and map show real pictures without a daemon.
import { DEFAULT_NOW } from "./world.js";

const PALETTE = ["#9aa5b1", "#b8a99a", "#a3b8a3", "#b3a3b8", "#a3b3b8", "#b8a3a3", "#c4b88a", "#8aa0c4"];

/** An inline picture: a flat colour with a label, any aspect ratio. */
export function svgImage(label, color, w = 400, h = 300) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" font-family="monospace" font-size="${Math.max(14, Math.round(Math.min(w, h) / 10))}" fill="#222" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const thumbCache = new Map();
function cachedThumb(i, w, h) {
  const key = `${i % PALETTE.length}:${w}x${h}`;
  if (!thumbCache.has(key)) thumbCache.set(key, svgImage(`${w}×${h}`, PALETTE[i % PALETTE.length], Math.min(w, 600), Math.min(h, 600)));
  return thumbCache.get(key);
}

const CAMERAS = [
  ["Canon", "EOS R6", "RF 24-70mm f/2.8"],
  ["Apple", "iPhone 15", "iPhone 15 back camera 6.8mm f/1.6"],
  ["Sony", "A7 IV", "FE 35mm f/1.8"],
  ["Google", "Pixel 8", ""],
];
// A handful of real-looking places: [lat, lon].
const SPOTS = [[48.8584, 2.2945], [51.5007, -0.1246], [40.7484, -73.9857], [35.6586, 139.7454], [-33.8568, 151.2153], [64.1466, -21.9426]];

/**
 * @param {number} count
 * @param {{ start?: number, spanDays?: number, drive?: string, videoEvery?: number, gpsEvery?: number,
 *   undatedEvery?: number, favEvery?: number, broken?: number[], prefix?: string }} [o]
 */
export function makePhotos(count, o = {}) {
  const { start = DEFAULT_NOW, spanDays = 900, drive = "d1", videoEvery = 0, gpsEvery = 3, undatedEvery = 0, favEvery = 0, broken = [], prefix = "IMG" } = o;
  const out = [];
  for (let i = 0; i < count; i++) {
    const video = videoEvery > 0 && i % videoEvery === videoEvery - 1;
    const undated = undatedEvery > 0 && i % undatedEvery === undatedEvery - 1;
    const portrait = i % 5 === 2;
    const w = portrait ? 3000 : 4000;
    const h = portrait ? 4000 : 3000;
    const cam = CAMERAS[i % CAMERAS.length];
    const spot = gpsEvery > 0 && i % gpsEvery === 0 ? SPOTS[i % SPOTS.length] : null;
    const ext = video ? "mp4" : i % 7 === 3 ? "heic" : "jpg";
    const name = `${prefix}_${String(i + 1).padStart(4, "0")}.${ext}`;
    const path = `Photos/${name}`;
    out.push({
      drive_id: drive,
      path,
      name,
      kind: video ? "video" : "photo",
      size: 2_000_000 + (i % 40) * 150_000,
      width: w,
      height: h,
      taken_at: undated ? null : Math.floor(start / 1000) - Math.floor((i / Math.max(1, count)) * spanDays * 86400),
      thumb: broken.includes(i) ? `/dev-broken-thumb/${i}.jpg` : cachedThumb(i, w, h),
      content: broken.includes(i) ? undefined : cachedThumb(i, w, h),
      favorited: favEvery > 0 && i % favEvery === 0,
      duration_secs: video ? 12 + (i % 90) : undefined,
      camera_make: cam[0],
      camera_model: cam[1],
      lens: cam[2],
      iso: 100 * (1 + (i % 8)),
      focal_mm: 24 + (i % 6) * 10,
      flash: i % 9 === 0,
      lat: spot ? spot[0] + (i % 10) * 0.0004 : undefined,
      lon: spot ? spot[1] + (i % 10) * 0.0004 : undefined,
      private: false,
    });
  }
  return out;
}

export const photoKey = (p) => `${p.drive_id}\0${p.path}`;
