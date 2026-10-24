import { makePhotos, photoKey } from "../fake/photos.js";
import { user } from "../fake/world.js";

const memberSam = (w) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
};
const asMember = (w) => { memberSam(w); w.sessionUserId = "u2"; };
const album = (w, id, name, over = {}, photos = []) => {
  w.albums.push({ id, home_drive_id: "d1", name, owner_user_id: "u1", locked: false, created_at: 1_700_000_000, ...over });
  w.albumItems ||= {};
  w.albumItems[id] = photos.map(photoKey);
};
const lib = (w, n, o) => { w.photos = makePhotos(n, o); };
const hashFor = (p) => `#library?p=${encodeURIComponent(p.drive_id)}|${encodeURIComponent(p.path)}`;
const SEARCH = "Type a search that matches nothing (zzzz); it should say so and offer a way back";

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── Library states ────────────────────────────────────────────────────────
  {
    id: "gallery/normal",
    area: "Photos",
    title: "Ordinary library (60 photos)",
    url: "/gallery",
    check: ["Grid fills with colored pictures, newest first", "Library · Albums · Places · Favorites tabs all open", "Click a photo: it opens large; arrows and Escape work", "Heart a photo, then check Favorites: it is there"],
  },
  {
    id: "gallery/empty",
    area: "Photos",
    title: "Empty library",
    url: "/gallery",
    seed: (w) => { w.photos = []; },
    check: ["Empty state says there are no photos yet and what to do", "No endless spinner", "Rescan (as Admin) answers with a message"],
  },
  {
    id: "gallery/scan-running",
    area: "Photos",
    title: "Still looking for photos (scan running)",
    url: "/gallery",
    seed: (w) => { w.photos = []; w.gallery = { busy: true, scanForever: true, found_count: 1240, drive_label: "Family photos", last_error: "" }; },
    check: ["Page says Luna is looking and shows 'Found 1240 photos on Family photos'", "It does not look like an empty library or an error"],
  },
  {
    id: "gallery/scan-running-with-photos",
    area: "Photos",
    title: "Scan running while photos already show",
    url: "/gallery",
    seed: (w) => { lib(w, 80); w.gallery = { busy: true, scanForever: true, found_count: 80, drive_label: "", last_error: "" }; },
    check: ["Grid is usable while the progress line shows", "Progress line does not cover the first row"],
  },
  {
    id: "gallery/scan-finishes",
    area: "Photos",
    title: "Rescan runs, then finishes",
    url: "/gallery",
    seed: (w) => { lib(w, 40); w.gallery = { busy: false, scanMs: 5000, found_count: 0, drive_label: "Family photos", last_error: "" }; },
    check: ["Press Rescan: toast says Luna is rescanning", "Progress count climbs, then the line goes away on its own", "Grid still shows the photos afterwards"],
  },
  {
    id: "gallery/scan-failed",
    area: "Photos",
    title: "Last scan failed",
    url: "/gallery",
    seed: (w) => { lib(w, 30); w.gallery = { busy: false, found_count: 0, last_error: "Luna couldn't read the drive 'Family photos'. Check that it is plugged in.", drive_label: "" }; },
    check: ["The failure is shown in plain words, naming the drive", "Rescan can be tried again", "Photos found earlier still show"],
  },
  {
    id: "gallery/scan-fails-at-end",
    area: "Photos",
    title: "Rescan fails near the end",
    url: "/gallery",
    seed: (w) => { lib(w, 30); w.gallery = { busy: false, scanMs: 3000, scanFailsAtEnd: true, found_count: 0, drive_label: "Family photos", last_error: "" }; },
    check: ["Start Rescan, wait 3 seconds", "An error message appears instead of a silent stop"],
  },
  {
    id: "gallery/rescan-refused",
    area: "Photos",
    title: "Rescan answers an error",
    url: "/gallery",
    seed: (w) => lib(w, 20),
    faults: [{ match: "POST /api/v1/gallery/rescan", mode: "500", message: "Luna couldn't start the scan." }],
    check: ["Press Rescan: the page shows 'Luna couldn't start the scan.' (or the plain fallback)", "Nothing else breaks"],
  },
  {
    id: "gallery/huge-library",
    area: "Photos",
    title: "30,000 photos",
    url: "/gallery",
    seed: (w) => lib(w, 30000, { spanDays: 4000, videoEvery: 40, favEvery: 100, undatedEvery: 500 }),
    check: ["Scroll stays smooth; more load as you reach the end", "Day jump (calendar) reaches an old year", "Select all does not freeze the page", "Favorites tab only shows hearted ones"],
  },
  {
    id: "gallery/odd-exif",
    area: "Photos",
    title: "Missing and odd dates, cameras and sizes",
    url: "/gallery",
    seed: (w) => {
      lib(w, 40, { undatedEvery: 3 });
      w.photos[0].taken_at = 0; // 1970
      w.photos[1].taken_at = Math.floor(Date.UTC(2038, 0, 1) / 1000); // far future
      w.photos[2].camera_make = ""; w.photos[2].camera_model = "";
      w.photos[4].width = undefined; w.photos[4].height = undefined;
      w.photos[5].name = "Ünïcode — a very long file name that keeps going and going and going and going.jpg";
      w.photos[6].size = 0;
    },
    check: ["Undated photos sit at the end under a clear heading", "The 1970 and 2038 photos show a sensible date or 'unknown', never 'Invalid Date'", "Open photo details for a photo with no camera: nothing says 'undefined'", "Long file name is cut off cleanly"],
  },
  {
    id: "gallery/videos",
    area: "Photos",
    title: "Library full of videos",
    url: "/gallery",
    seed: (w) => lib(w, 50, { videoEvery: 2 }),
    check: ["Videos show a Video badge and length", "Filters → Videos only keeps only videos", "Opening a video in the large view shows a player or a clear message (the fake has no real video file)"],
  },
  {
    id: "gallery/extreme-sizes",
    area: "Photos",
    title: "Huge and tiny images",
    url: "/gallery",
    seed: (w) => {
      lib(w, 24);
      w.photos[0].width = 60000; w.photos[0].height = 40000;
      w.photos[1].width = 1; w.photos[1].height = 1;
      w.photos[2].width = 12000; w.photos[2].height = 200; // panorama strip
      w.photos[3].width = 200; w.photos[3].height = 12000;
      w.photos[4].size = 9_000_000_000;
    },
    check: ["Grid cells stay square-ish and tidy for the strip images", "Photo details give sensible megapixels and a size like 8.4 GB", "Filter 'at least 20 megapixels' keeps the first photo only (of these)"],
  },
  {
    id: "gallery/broken-thumbs",
    area: "Photos",
    title: "Thumbnails that will not load",
    url: "/gallery",
    seed: (w) => lib(w, 30, { broken: [0, 1, 2, 5, 6, 7, 8] }),
    check: ["Broken ones show a calm placeholder, not a torn-image icon", "Opening a broken photo says it cannot be shown and still offers Download", "Neighbors are unaffected"],
  },
  {
    id: "gallery/slow-load",
    area: "Photos",
    title: "Library answers slowly, then fails",
    url: "/gallery",
    seed: (w) => lib(w, 40),
    faults: [{ match: "GET /api/v1/gallery", mode: "slow:5000" }],
    check: ["Skeleton/looking state shows during the wait", "Switching tabs while waiting does not duplicate the grid"],
  },
  {
    id: "gallery/server-error",
    area: "Photos",
    title: "Library request fails (500)",
    url: "/gallery",
    seed: (w) => lib(w, 40),
    faults: [{ match: "GET /api/v1/gallery", mode: "500", message: "Luna couldn't read your photos." }],
    check: ["An error with a Try again action shows", "Not a blank page and not 'no photos yet'"],
  },
  {
    id: "gallery/no-drives-member",
    area: "Photos",
    title: "Member with no drives and no albums",
    url: "/gallery",
    seed: (w) => { asMember(w); w.photos = []; },
    check: ["Plain message that nothing is shared with them yet", "No Rescan or Upload offered", "No error messages"],
  },

  // ── Filters and search ───────────────────────────────────────────────────
  {
    id: "gallery/search-no-results",
    area: "Photos",
    title: "Search and filters with no results",
    url: "/gallery",
    seed: (w) => lib(w, 40),
    check: [SEARCH, "Open Filters and choose Camera + 'Has location: No' + 'Videos': shows 'no matches' with a Clear filters button", "Clear filters brings the grid back", "On this day banner either shows photos or stays hidden"],
  },
  {
    id: "gallery/filters-facets-fail",
    area: "Photos",
    title: "Filter sheet cannot load cameras",
    url: "/gallery",
    seed: (w) => lib(w, 40),
    faults: [{ match: "/api/v1/gallery/cameras", mode: "500" }, { match: "/api/v1/gallery/filter-facets", mode: "500" }],
    check: ["Open Filters: it still opens", "Camera list just says Any camera", "Other filters still work"],
  },

  // ── Albums ───────────────────────────────────────────────────────────────
  {
    id: "gallery/albums-none",
    area: "Photos",
    title: "Albums tab with no albums",
    url: "/gallery#albums",
    seed: (w) => lib(w, 30),
    check: ["Empty state explains what an album is and has New album", "Create one: name it, it appears", "Creating a second with the same name says so in plain words"],
  },
  {
    id: "gallery/albums-mixed",
    area: "Photos",
    title: "Albums: empty, big, shared, locked",
    url: "/gallery#albums",
    seed: (w) => {
      memberSam(w);
      lib(w, 200, { favEvery: 7 });
      album(w, "al-empty", "Nothing yet");
      album(w, "al-big", "Everything from 2024", {}, w.photos.slice(0, 180));
      album(w, "al-shared", "Shared with Sam", { shared_with: ["u2"] }, w.photos.slice(10, 20));
      album(w, "al-locked", "Private stuff", { locked: true }, w.photos.slice(20, 25));
      album(w, "al-long", "A truly extraordinarily long album name that should be cut off neatly instead of pushing the layout around", {}, w.photos.slice(30, 33));
    },
    check: ["Empty album says it is empty and offers adding photos", "Locked album asks before opening", "Rename, set cover, lock/unlock, delete each show a toast and stick", "Long name is cut off cleanly", "Delete an album then reload tab: it is gone"],
  },
  {
    id: "gallery/album-huge",
    area: "Photos",
    title: "Album with thousands of photos",
    url: "/gallery#albums",
    seed: (w) => {
      lib(w, 6000, { spanDays: 1500 });
      album(w, "al-huge", "Whole year", {}, w.photos);
    },
    check: ["Album card shows 6000 photos", "Open it: scrolling loads more smoothly", "Select 50, remove from album: count drops by 50"],
  },
  {
    id: "gallery/album-deleted-while-open",
    area: "Photos",
    title: "Album deleted while you have it open",
    url: "/gallery#albums",
    seed: (w) => {
      lib(w, 40);
      album(w, "al-vanish", "Disappearing album", {}, w.photos.slice(0, 10));
      w.gallery = { busy: false, found_count: 0, drive_label: "", last_error: "", vanishAlbum: "al-vanish" };
    },
    check: ["Open 'Disappearing album': Luna says the album no longer exists", "You land back on the Albums list, and it is not there any more", "No blank page"],
  },
  {
    id: "gallery/album-member-view",
    area: "Photos",
    title: "Member opens an album shared with them",
    url: "/gallery#albums",
    seed: (w) => {
      lib(w, 40);
      album(w, "al-theirs", "Sam's own", { owner_user_id: "u2" }, w.photos.slice(0, 5));
      album(w, "al-admins", "Admin shared it", { shared_with: ["u2"] }, w.photos.slice(5, 12));
      album(w, "al-hidden", "Admin only", {}, w.photos.slice(12, 15));
      asMember(w);
    },
    check: ["Sam sees only 'Sam's own' and 'Admin shared it'", "Rename/Delete on the shared one is not offered (or is refused in plain words)", "Share button on their own album opens the sharing sheet"],
  },
  {
    id: "gallery/album-add-fails-partway",
    area: "Photos",
    title: "Adding to albums fails halfway",
    url: "/gallery",
    seed: (w) => {
      lib(w, 40);
      album(w, "al-a", "First", {});
      album(w, "al-b", "Second", {});
      w.gallery = { busy: false, found_count: 0, drive_label: "", last_error: "", failAfter: 1 };
    },
    check: ["Select 5 photos → Add to album → tick both albums → save", "One album is changed, then an error explains something went wrong", "Open the first album: it has the photos; the second does not", "Selection is kept so you can try again"],
  },

  // ── Places ───────────────────────────────────────────────────────────────
  {
    id: "gallery/places-none",
    area: "Photos",
    title: "Places with no located photos",
    url: "/gallery#places",
    seed: (w) => lib(w, 40, { gpsEvery: 0 }),
    check: ["Places tab explains that no photos have a location", "No map error and no endless spinner"],
  },
  {
    id: "gallery/places-many",
    area: "Photos",
    title: "Places with thousands of pins",
    url: "/gallery#places",
    seed: (w) => lib(w, 4000, { gpsEvery: 1 }),
    check: ["Map loads and pins group into numbered clusters", "Zoom in: clusters split", "Click a cluster: photos from there show", "Draw an area (if offered): results narrow to it"],
  },
  {
    id: "gallery/places-fails",
    area: "Photos",
    title: "Places cannot load",
    url: "/gallery#places",
    seed: (w) => lib(w, 40),
    faults: [{ match: "GET /api/v1/gallery/places", mode: "500" }],
    check: ["Says places could not load, with a retry. If it says 'No places yet' as if nothing is wrong, record that as a problem", "Other tabs unaffected"],
    realLunadOnly: "Map tiles come from the internet; offline testers see an empty map background",
  },

  // ── Duplicates ───────────────────────────────────────────────────────────
  {
    id: "gallery/duplicates",
    area: "Photos",
    title: "Duplicate photos",
    url: "/gallery",
    seed: (w) => {
      lib(w, 40);
      [[0, 11], [1, 12], [2, 13]].forEach(([a, b], i) => { w.photos[a].dup = `g${i}`; w.photos[b].dup = `g${i}`; w.photos[b].name = w.photos[a].name; });
    },
    check: ["Open the duplicates view (toolbar menu): three groups of two", "Select one copy per group and move to Trash: the group shrinks or disappears", "With no duplicates (reload after clearing) it says none were found"],
  },
  {
    id: "gallery/duplicates-none",
    area: "Photos",
    title: "No duplicates",
    url: "/gallery",
    seed: (w) => lib(w, 40),
    check: ["Duplicates view says nothing was found, in plain words"],
  },

  // ── Selection, bulk, lightbox ───────────────────────────────────────────
  {
    id: "gallery/bulk-favorite-fails-partway",
    area: "Photos",
    title: "Bulk favorite fails halfway",
    url: "/gallery",
    seed: (w) => {
      lib(w, 30);
      w.gallery = { busy: false, found_count: 0, drive_label: "", last_error: "", failAfter: 2 };
    },
    check: ["Select 5 photos and press Favorite", "An error says some could not be added", "Favorites tab holds exactly 2 of them", "Library hearts match Favorites"],
  },
  {
    id: "gallery/download-fallback",
    area: "Photos",
    title: "Download selected photos",
    url: "/gallery",
    seed: (w) => lib(w, 20),
    check: ["Select 3, Download: the browser starts one download per photo (no zip in the fake)", "No error banner appears"],
  },
  {
    id: "gallery/lightbox-first",
    area: "Photos",
    title: "Large view on the first photo",
    url: "/gallery",
    seed: (w) => { lib(w, 25); },
    check: ["Open the first (newest) photo", "Previous is disabled or hidden; Left arrow does nothing", "Next goes to photo 2", "Details panel shows name, date, camera"],
  },
  {
    id: "gallery/lightbox-last",
    area: "Photos",
    title: "Large view on the last photo",
    url: "/gallery",
    seed: (w) => lib(w, 25),
    check: ["Scroll to the very end and open the last photo", "Next is disabled; Right arrow does nothing", "Previous goes back one", "Slideshow stops at the end"],
  },
  {
    id: "gallery/lightbox-deep-link",
    area: "Photos",
    title: "Reload on an open photo (link in the address)",
    url: `/gallery${hashFor({ drive_id: "d1", path: "Photos/IMG_0001.jpg" })}`,
    seed: (w) => lib(w, 25),
    check: ["The large view opens straight on IMG_0001", "Close returns to the grid, scrolled to the top"],
  },
  {
    id: "gallery/trash-fails",
    area: "Photos",
    title: "Moving a photo to Trash fails",
    url: "/gallery",
    seed: (w) => lib(w, 20),
    faults: [{ match: "DELETE /api/v1/drives/d1/files", mode: "409", message: "This drive is read-only right now, so Luna can't change it." }],
    check: ["Open a photo, press Trash, confirm", "The message explains the drive is read-only, in the page, not a crash", "The photo is still there"],
  },

  // ── Who / look ───────────────────────────────────────────────────────────
  {
    id: "gallery/member-with-drive-share",
    area: "Photos",
    title: "Member: no Rescan, no admin tools",
    url: "/gallery",
    seed: (w) => { lib(w, 30); asMember(w); w.access = [{ kind: "path", drive_id: "d1", path: "Photos", caps: "view" }]; },
    check: ["No Rescan button", "Upload only appears if their access allows it", "Everything else browses normally"],
  },
  {
    id: "gallery/phone",
    area: "Photos",
    title: "Photos on a phone",
    url: "/gallery",
    viewport: "phone",
    seed: (w) => { lib(w, 80, { videoEvery: 9, favEvery: 8 }); album(w, "al-p", "Weekend", {}, w.photos.slice(0, 8)); },
    check: ["Toolbar fits without sideways scrolling", "Long-press a photo starts selecting; the action bar fits the screen", "Large view: swipe left/right changes photo, swipe down closes", "Filter sheet scrolls and its buttons stay reachable"],
  },
  {
    id: "gallery/tablet-dark",
    area: "Photos",
    title: "Photos on a tablet, dark",
    url: "/gallery",
    viewport: "tablet",
    theme: "dark",
    seed: (w) => lib(w, 120, { videoEvery: 9 }),
    check: ["Grid column count suits the width", "Text on every bar and badge is readable in dark", "Large view's details panel does not cover the photo"],
  },
  {
    id: "gallery/offline",
    area: "Photos",
    title: "Photos while offline",
    url: "/gallery",
    offline: true,
    seed: (w) => lib(w, 40),
    check: ["The page says it cannot reach Luna (a blank page is a problem to record)", "Turn offline off in Break things, reload: the grid loads"],
  },
  {
    id: "gallery/on-this-day",
    area: "Photos",
    title: "On this day memories",
    url: "/gallery",
    now: Date.UTC(2026, 9, 18, 12),
    seed: (w) => {
      lib(w, 30);
      // Photos taken on 18 Oct in earlier years.
      [2025, 2024, 2022].forEach((y, i) => { w.photos[i].taken_at = Math.floor(Date.UTC(y, 9, 18, 10) / 1000); });
    },
    check: ["A banner offers 'On this day' with 3 photos", "Open it: only those three, with years", "Dismiss it: it stays gone after reload within the day"],
  },
];
