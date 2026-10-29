// Photos: the library, albums, places, duplicates, favorites, rescans.
// World fields (all optional, created on first use so other areas never need them):
//   world.photos        array from fake/photos.js (default: a small library)
//   world.gallery       { busy, scanForever, scanMs, found_count, drive_label, last_error,
//                         failAfter, cameras, facets, dupes }
//   world.albums        album rows; world.albumItems[id] = photo keys in it
import { del, fail, get, patch, post, put } from "../engine.js";
import { nextId } from "../world.js";
import { makePhotos, photoKey } from "../photos.js";

const state = (w) => {
  if (!w.photos) w.photos = makePhotos(60, { videoEvery: 12, favEvery: 9, undatedEvery: 25 });
  if (!w.albumItems) w.albumItems = {};
  if (!w.gallery) w.gallery = { busy: false, found_count: 0, drive_label: "", last_error: "" };
  return w.gallery;
};

/** Lets a scenario make an action fail after N successful calls ("fails partway"). */
function mayFail(g) {
  if (typeof g.failAfter !== "number") return null;
  if (g.failAfter <= 0) return fail(500, "Luna couldn't finish that. Some photos were changed before it stopped.");
  g.failAfter -= 1;
  return null;
}

const albumOf = (w, home, id) => w.albums.find((a) => a.id === id && a.home_drive_id === home);
const canSee = (a, u) => a.owner_user_id === u.id || u.role === "admin" || (a.shared_with || []).includes(u.id);

function albumRow(w, a) {
  const keys = w.albumItems[a.id] || [];
  const cover = a.cover_key ? w.photos.find((p) => photoKey(p) === a.cover_key) : w.photos.find((p) => photoKey(p) === keys[0]);
  return {
    id: a.id,
    home_drive_id: a.home_drive_id,
    name: a.name,
    locked: Boolean(a.locked),
    item_count: a.fakeCount ?? keys.length,
    cover_thumb: cover?.thumb || a.cover_thumb || "",
    created_at: a.created_at ?? Math.floor(Date.now() / 1000),
  };
}

get("/api/v1/gallery/albums", ({ world, user }) => {
  state(world);
  return world.albums.filter((a) => canSee(a, user)).map((a) => albumRow(world, a));
});

post("/api/v1/gallery/albums", ({ world, user, body }) => {
  const g = state(world);
  const name = String(body.name || "").trim();
  if (!name) return fail(400, "Give the album a name.");
  if (world.albums.some((a) => a.owner_user_id === user.id && a.name.toLowerCase() === name.toLowerCase())) {
    return fail(409, "You already have an album with that name.");
  }
  void g;
  const a = { id: nextId("al"), home_drive_id: "d1", name, owner_user_id: user.id, locked: false, created_at: Math.floor(Date.now() / 1000) };
  world.albums.push(a);
  world.albumItems[a.id] = [];
  return albumRow(world, a);
});

patch("/api/v1/gallery/albums/:drive/:id", ({ world, user, params, body }) => {
  state(world);
  const a = albumOf(world, params.drive, params.id);
  if (!a) return fail(404, "That album no longer exists.");
  if (a.owner_user_id !== user.id && user.role !== "admin") return fail(403, "Only the person who made this album can change it.");
  if (body.name !== undefined) a.name = String(body.name).trim() || a.name;
  if (body.locked !== undefined) a.locked = Boolean(body.locked);
  if (body.cover_path) a.cover_key = `${body.cover_drive_id}\0${body.cover_path}`;
  return albumRow(world, a);
});

del("/api/v1/gallery/albums/:drive/:id", ({ world, user, params }) => {
  state(world);
  const a = albumOf(world, params.drive, params.id);
  if (!a) return fail(404, "That album no longer exists.");
  if (a.owner_user_id !== user.id && user.role !== "admin") return fail(403, "Only the person who made this album can delete it.");
  world.albums = world.albums.filter((x) => x !== a);
  delete world.albumItems[a.id];
  return {};
});

post("/api/v1/gallery/albums/:drive/:id/items", ({ world, params, body }) => {
  const g = state(world);
  const a = albumOf(world, params.drive, params.id);
  if (!a) return fail(404, "That album no longer exists.");
  const denied = mayFail(g);
  if (denied) return denied;
  const set = new Set(world.albumItems[a.id] || []);
  for (const it of body.items || []) set.add(`${it.drive_id}\0${it.path}`);
  world.albumItems[a.id] = [...set];
  delete a.fakeCount;
  return { added: (body.items || []).length };
});

del("/api/v1/gallery/albums/:drive/:id/items", ({ world, params, body }) => {
  const g = state(world);
  const a = albumOf(world, params.drive, params.id);
  if (!a) return fail(404, "That album no longer exists.");
  const denied = mayFail(g);
  if (denied) return denied;
  const gone = `${body.drive_id}\0${body.path}`;
  world.albumItems[a.id] = (world.albumItems[a.id] || []).filter((k) => k !== gone);
  delete a.fakeCount;
  return {};
});

// ── Library ─────────────────────────────────────────────────────────────────
const num = (v) => (v === undefined || v === "" ? null : Number(v));

function matches(w, p, q) {
  if (q.favorites === "true" && !p.favorited) return false;
  if (q.kind && p.kind !== q.kind) return false;
  if (q.undated === "true") return p.taken_at == null;
  if (q.from !== undefined && (p.taken_at == null || p.taken_at < Number(q.from))) return false;
  if (q.to !== undefined && (p.taken_at == null || p.taken_at > Number(q.to))) return false;
  if (q.q) {
    const hay = `${p.name} ${p.camera_make || ""} ${p.camera_model || ""}`.toLowerCase();
    if (!hay.includes(String(q.q).toLowerCase())) return false;
  }
  if (q.camera_make && p.camera_make !== q.camera_make) return false;
  if (q.camera_model && p.camera_model !== q.camera_model) return false;
  if (q.lens && p.lens !== q.lens) return false;
  if (q.orientation) {
    const o = p.width > p.height ? "landscape" : p.width < p.height ? "portrait" : "square";
    if (o !== q.orientation) return false;
  }
  if (q.has_gps === "true" && p.lat == null) return false;
  if (q.has_gps === "false" && p.lat != null) return false;
  if (q.format && !p.name.toLowerCase().endsWith(`.${String(q.format).toLowerCase()}`)) return false;
  if (q.flash === "1" && !p.flash) return false;
  if (q.flash === "0" && p.flash) return false;
  const isoMin = num(q.iso_min), isoMax = num(q.iso_max);
  if ((isoMin != null && p.iso < isoMin) || (isoMax != null && p.iso > isoMax)) return false;
  const fMin = num(q.focal_min), fMax = num(q.focal_max);
  if ((fMin != null && p.focal_mm < fMin) || (fMax != null && p.focal_mm > fMax)) return false;
  const mp = num(q.min_megapixels);
  if (mp != null && (p.width * p.height) / 1e6 < mp) return false;
  const dMin = num(q.min_duration), dMax = num(q.max_duration);
  if (dMin != null && !(p.duration_secs >= dMin)) return false;
  if (dMax != null && !(p.duration_secs <= dMax)) return false;
  if (q.hour_from !== undefined || q.hour_to !== undefined) {
    if (p.taken_at == null) return false;
    const h = new Date(p.taken_at * 1000).getUTCHours();
    if (h < Number(q.hour_from ?? 0) || h > Number(q.hour_to ?? 23)) return false;
  }
  if (q.month_day) {
    if (p.taken_at == null) return false;
    if (new Date(p.taken_at * 1000).toISOString().slice(5, 10) !== q.month_day) return false;
  }
  if (q.album_membership) {
    const inAny = Object.values(w.albumItems).some((keys) => keys.includes(photoKey(p)));
    if (q.album_membership === "any" && !inAny) return false;
    if (q.album_membership === "none" && inAny) return false;
  }
  if (q.place_bbox) {
    const [x0, y0, x1, y1] = String(q.place_bbox).split(",").map(Number);
    if (p.lat == null || p.lon < x0 || p.lon > x1 || p.lat < y0 || p.lat > y1) return false;
  } else if (q.place) {
    if (placeKey(p) !== q.place) return false;
  }
  return true;
}

const placeKey = (p) => (p.lat == null ? "" : `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`);

function listPhotos(world, user, query) {
  state(world);
  let pool = world.photos;
  if (query.album_id) {
    const a = albumOf(world, query.album_home, query.album_id);
    if (!a || !canSee(a, user)) throw Object.assign(new Error("gone"), { gone: true });
    const keys = new Set(world.albumItems[a.id] || []);
    pool = pool.filter((p) => keys.has(photoKey(p)));
  }
  const found = pool.filter((p) => matches(world, p, query));
  found.sort((a, b) => (b.taken_at ?? -1) - (a.taken_at ?? -1));
  return found;
}

get("/api/v1/gallery", ({ world, user, query }) => {
  const g = state(world);
  if (g.vanishAlbum && g.vanishAlbum === query.album_id) {
    world.albums = world.albums.filter((a) => a.id !== g.vanishAlbum);
    g.vanishAlbum = null;
  }
  let found;
  try { found = listPhotos(world, user, query); } catch (e) {
    if (e.gone) return fail(404, "That album no longer exists.");
    throw e;
  }
  const limit = Math.min(Number(query.limit) || 80, 500);
  const offset = Number(query.offset) || 0;
  const items = found.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, has_more: end < found.length, next_offset: end, total: found.length };
});

get("/api/v1/gallery/places", ({ world, user, query }) => {
  const found = listPhotos(world, user, { ...query, place: undefined, place_bbox: undefined }).filter((p) => p.lat != null);
  const groups = new Map();
  for (const p of found) {
    const k = placeKey(p);
    const g = groups.get(k) || { key: k, label: `Near ${p.lat.toFixed(1)}, ${p.lon.toFixed(1)}`, count: 0, lat: p.lat, lon: p.lon, cover_thumb: p.thumb };
    g.count += 1;
    groups.set(k, g);
  }
  return [...groups.values()];
});

get("/api/v1/gallery/status", ({ world }) => {
  const g = state(world);
  if (g.busy && !g.scanForever) {
    const elapsed = Date.now() - (g.scanStarted || Date.now());
    const total = g.scanTotal ?? world.photos.length;
    g.found_count = Math.min(total, Math.floor((elapsed / (g.scanMs || 4000)) * total));
    if (elapsed >= (g.scanMs || 4000)) {
      g.busy = false;
      if (g.scanFailsAtEnd) g.last_error = "Luna couldn't read one of your drives while looking for photos.";
    }
  }
  return { busy: Boolean(g.busy), scanning: Boolean(g.busy), phase: g.phase ?? (g.busy ? "scanning" : "idle"), pending: g.pending ?? 0, drive_id: null, drive_label: g.drive_label || null, found_count: g.found_count || 0, last_error: g.last_error || null };
});

post("/api/v1/gallery/rescan", ({ world, user }) => {
  const g = state(world);
  if (user.role !== "admin") return fail(403, "Only an Admin can rescan photos.");
  if (g.busy) return fail(409, "Luna is already looking through your photos.");
  g.busy = true;
  g.scanStarted = Date.now();
  g.last_error = "";
  g.found_count = 0;
  return {};
});

get("/api/v1/gallery/cameras", ({ world }) => {
  const g = state(world);
  if (g.cameras) return { cameras: g.cameras };
  const seen = new Map();
  for (const p of world.photos) {
    if (!p.camera_make && !p.camera_model) continue;
    const k = `${p.camera_make}|${p.camera_model}`;
    seen.set(k, { make: p.camera_make, model: p.camera_model, count: (seen.get(k)?.count || 0) + 1 });
  }
  return { cameras: [...seen.values()] };
});

get("/api/v1/gallery/filter-facets", ({ world }) => {
  const g = state(world);
  if (g.facets !== undefined) return g.facets;
  const lenses = [...new Set(world.photos.map((p) => p.lens).filter(Boolean))];
  return { lenses, formats: [...new Set(world.photos.map((p) => p.name.split(".").pop().toLowerCase()))], iso: true, focal: true, flash: true };
});

get("/api/v1/gallery/duplicates", ({ world }) => {
  const g = state(world);
  const groups = new Map();
  for (const p of world.photos) {
    if (!p.dup) continue;
    (groups.get(p.dup) || groups.set(p.dup, []).get(p.dup)).push(p);
  }
  void g;
  return { groups: [...groups.entries()].map(([key, items]) => ({ key, name: items[0].name, items })) };
});

put("/api/v1/gallery/favorites", ({ world, body }) => {
  const g = state(world);
  const denied = mayFail(g);
  if (denied) return denied;
  const p = world.photos.find((x) => x.drive_id === body.drive_id && x.path === body.path);
  if (!p) return fail(404, "That photo is no longer on Luna.");
  p.favorited = true;
  return {};
});
del("/api/v1/gallery/favorites", ({ world, body }) => {
  state(world);
  const p = world.photos.find((x) => x.drive_id === body.drive_id && x.path === body.path);
  if (p) p.favorited = false;
  return {};
});

// The zip download answers 404 so the page falls back to one download per photo.
post("/api/v1/gallery/download", () => fail(404, "No zip download in the state gallery."));

get("/api/v1/gallery/preview", ({ query }) => ({ ok: true, path: query.path }));
