/* eslint-disable react-refresh/only-export-components -- page exports helpers used by tests */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Film,
  Image as ImageIcon,
  Lock,
  Pencil,
  Plus,
  PlugZap,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import EmptyState from "../components/common/EmptyState";
import Card from "../components/cards/Card";
import PageNotice from "../components/common/PageNotice";
import ModalErrorNotice from "../components/common/ModalErrorNotice";
import { showPageLevelError } from "../lib/modalScopedError";
import ModalCard from "../components/cards/ModalCard";
import GalleryToolbar from "../components/gallery/GalleryToolbar.jsx";
import GalleryFilterSheet, {
  EMPTY_FILTERS,
  clearFilterChip,
  countActiveFilters,
  filterChipList,
} from "../components/gallery/GalleryFilterSheet.jsx";
import ConfirmModal from "../components/cards/ConfirmModal";
import CreateShareModal from "../components/files/CreateShareModal";
import PhotoTimeline from "../components/gallery/PhotoTimeline.jsx";
import PhotoLightbox, {
  ABOVE_LIGHTBOX_OVERLAY_CLASS,
} from "../components/gallery/PhotoLightbox.jsx";
import AddToAlbumModal from "../components/gallery/AddToAlbumModal.jsx";
import ShareAlbumModal from "../components/gallery/ShareAlbumModal.jsx";
import SelectionActionBar from "../components/gallery/SelectionActionBar.jsx";
import YearScrubber, { dayBoundsLocal } from "../components/gallery/YearScrubber.jsx";
import PhotoEditModal from "../components/gallery/PhotoEditModal.jsx";
import AlbumMembersPanel from "../components/gallery/AlbumMembersPanel.jsx";
import PlacesMap from "../components/gallery/PlacesMap.jsx";
import PhotoThumb from "../components/gallery/PhotoThumb.jsx";
import Spinner from "../components/ui/Spinner.jsx";
import Dropdown from "../components/common/Dropdown.jsx";
import useMultiSelect, { photoSelectionKey } from "../hooks/useMultiSelect.js";
import { downloadHref } from "../lib/paths.js";
import { useAuth } from "../context/AuthContext";
import { haptic } from "../utils/haptics.js";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  getJson,
  patchJson,
  postForm,
  postJson,
  putJson,
} from "../lib/api";

/** @param {{ owner_user_id?: string }|null|undefined} album @param {{ id?: string, role?: string }|null|undefined} user */
function canManageAlbum(album, user) {
  if (!album || !user) return false;
  return user.role === "admin" || album.owner_user_id === user.id;
}

const SEGMENTS = [
  { value: "library", label: "Library" },
  { value: "albums", label: "Albums" },
  { value: "places", label: "Places" },
  { value: "favorites", label: "Favorites" },
  { value: "archive", label: "Archive" },
];

const SEGMENT_IDS = SEGMENTS.map((s) => s.value);
const DEFAULT_SEGMENT = "library";
const GRID_COLS_KEY = "luna.photos.gridCols";

/**
 * Build the gallery list URL. Bool query flags must be `true`/`false` —
 * lunad's serde query parser rejects `1`/`0` (Favorites used to 400).
 *
 * @param {{
 *   q?: string,
 *   favorites?: boolean,
 *   archived?: boolean,
 *   albumId?: string,
 *   albumHome?: string,
 *   place?: string,
 *   placeBbox?: string,
 *   from?: number,
 *   to?: number,
 *   kind?: string,
 *   cameraMake?: string,
 *   cameraModel?: string,
 *   orientation?: string,
 *   hasGps?: string,
 *   format?: string,
 *   hourFrom?: string|number,
 *   hourTo?: string|number,
 *   isoMin?: string|number,
 *   isoMax?: string|number,
 *   focalMin?: string|number,
 *   focalMax?: string|number,
 *   flash?: string,
 *   minMegapixels?: string|number,
 *   minDuration?: string|number,
 *   maxDuration?: string|number,
 *   lens?: string,
 *   undated?: boolean,
 *   albumMembership?: string,
 *   offset?: number,
 * }} opts
 */
export function galleryUrl({
  q,
  favorites,
  archived,
  albumId,
  albumHome,
  place,
  placeBbox,
  from,
  to,
  kind,
  cameraMake,
  cameraModel,
  orientation,
  hasGps,
  format,
  hourFrom,
  hourTo,
  isoMin,
  isoMax,
  focalMin,
  focalMax,
  flash,
  minMegapixels,
  minDuration,
  maxDuration,
  lens,
  undated,
  albumMembership,
  offset,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", "80");
  params.set("offset", String(offset || 0));
  if (q) params.set("q", q);
  if (favorites) params.set("favorites", "true");
  if (archived) params.set("archived", "true");
  if (albumId) params.set("album_id", albumId);
  if (albumHome) params.set("album_home", albumHome);
  if (placeBbox) params.set("place_bbox", placeBbox);
  else if (place) params.set("place", place);
  if (typeof from === "number") params.set("from", String(from));
  if (typeof to === "number") params.set("to", String(to));
  if (kind) params.set("kind", kind);
  if (cameraMake) params.set("camera_make", cameraMake);
  if (cameraModel) params.set("camera_model", cameraModel);
  if (orientation) params.set("orientation", orientation);
  if (hasGps === "yes") params.set("has_gps", "true");
  if (hasGps === "no") params.set("has_gps", "false");
  if (format) params.set("format", format);
  if (hourFrom !== "" && hourFrom != null) params.set("hour_from", String(hourFrom));
  if (hourTo !== "" && hourTo != null) params.set("hour_to", String(hourTo));
  if (isoMin !== "" && isoMin != null) params.set("iso_min", String(isoMin));
  if (isoMax !== "" && isoMax != null) params.set("iso_max", String(isoMax));
  if (focalMin !== "" && focalMin != null) params.set("focal_min", String(focalMin));
  if (focalMax !== "" && focalMax != null) params.set("focal_max", String(focalMax));
  if (flash === "on") params.set("flash", "1");
  if (flash === "off") params.set("flash", "0");
  if (flash === "1" || flash === "0") params.set("flash", flash);
  if (minMegapixels !== "" && minMegapixels != null) {
    params.set("min_megapixels", String(minMegapixels));
  }
  if (minDuration !== "" && minDuration != null) params.set("min_duration", String(minDuration));
  if (maxDuration !== "" && maxDuration != null) params.set("max_duration", String(maxDuration));
  if (lens) params.set("lens", lens);
  if (undated) params.set("undated", "true");
  if (albumMembership === "any" || albumMembership === "none") {
    params.set("album_membership", albumMembership);
  }
  return `/api/v1/gallery?${params}`;
}

/**
 * Parse Photos deep-link hash without breaking segment ids.
 * @param {string} hash
 */
export function parseGalleryHash(hash) {
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return { segment: DEFAULT_SEGMENT };
  if (raw.startsWith("day/")) {
    const day = raw.slice(4);
    return { segment: "library", day };
  }
  if (raw.startsWith("albums/")) {
    const rest = raw.slice("albums/".length);
    const [home, id] = rest.split("/");
    if (home && id) return { segment: "albums", albumHome: home, albumId: id };
    return { segment: "albums" };
  }
  if (SEGMENT_IDS.includes(raw)) return { segment: raw };
  return { segment: DEFAULT_SEGMENT };
}

function unlockKey(album) {
  return `luna.photos.unlock.${album.home_drive_id}:${album.id}`;
}

function readGridCols() {
  try {
    const n = Number(localStorage.getItem(GRID_COLS_KEY));
    if ([3, 4, 5, 6].includes(n)) return n;
  } catch {
    /* ignore */
  }
  return 6;
}

export default function GalleryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const initialHash =
    typeof window !== "undefined" ? parseGalleryHash(window.location.hash) : { segment: DEFAULT_SEGMENT };

  const [segment, setSegment] = useState(initialHash.segment || DEFAULT_SEGMENT);
  const activeSegment = SEGMENT_IDS.includes(segment) ? segment : DEFAULT_SEGMENT;
  const [error, setError] = useState(null);
  const [undoNotice, setUndoNotice] = useState(/** @type {string|null} */ (null));
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterFocus, setFilterFocus] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [duplicatesView, setDuplicatesView] = useState(false);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS }));
  const [place, setPlace] = useState(null);
  const [placesDrawMode, setPlacesDrawMode] = useState(false);
  const [albumView, setAlbumView] = useState(null);
  const [dayFilter, setDayFilter] = useState(
    /** @type {{ ymd: string, from: number, to: number, label: string }|null} */ (
      initialHash.day ? (() => {
        const b = dayBoundsLocal(initialHash.day);
        return b ? { ymd: initialHash.day, ...b } : null;
      })() : null
    ),
  );
  const [lightbox, setLightbox] = useState(/** @type {{ key: string }|null} */ (null));
  const [lightboxOverride, setLightboxOverride] = useState(/** @type {object[]|null} */ (null));
  const [slideshow, setSlideshow] = useState(false);
  const [sharePhoto, setSharePhoto] = useState(null);
  const [trashPhoto, setTrashPhoto] = useState(null);
  const [trashBulk, setTrashBulk] = useState(/** @type {object[]|null} */ (null));
  const [trashAlbum, setTrashAlbum] = useState(null);
  const [shareAlbum, setShareAlbum] = useState(null);
  const [albumPick, setAlbumPick] = useState(/** @type {object[]|null} */ (null));
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [newAlbumSeed, setNewAlbumSeed] = useState(/** @type {object[]|null} */ (null));
  const [shareAfterCreate, setShareAfterCreate] = useState(false);
  const [renameAlbum, setRenameAlbum] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [yearOpen, setYearOpen] = useState(false);
  const [editPhoto, setEditPhoto] = useState(null);
  const [columns, setColumns] = useState(readGridCols);
  const [lockedGate, setLockedGate] = useState(null);
  const dropZoneRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  useEffect(() => {
    try {
      localStorage.setItem(GRID_COLS_KEY, String(columns));
    } catch {
      /* ignore */
    }
  }, [columns]);

  // Hash sync — segments, day filters, album deep links.
  useEffect(() => {
    let next = `#${activeSegment}`;
    if (dayFilter?.ymd) next = `#day/${dayFilter.ymd}`;
    else if (albumView?.home_drive_id && albumView?.id) {
      next = `#albums/${albumView.home_drive_id}/${albumView.id}`;
    }
    if (window.location.hash === next) return;
    // Prefer replace for segment-only chrome so we don't flood history on first paint.
    if (next === `#${activeSegment}` && !window.location.hash.slice(1)) {
      window.history.replaceState(null, "", next);
      return;
    }
    if (window.location.hash.slice(1) === activeSegment && next === `#${activeSegment}`) return;
    window.history.replaceState(null, "", next);
  }, [activeSegment, dayFilter, albumView]);

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseGalleryHash(window.location.hash);
      if (SEGMENT_IDS.includes(parsed.segment)) setSegment(parsed.segment);
      if (parsed.day) {
        const b = dayBoundsLocal(parsed.day);
        if (b) setDayFilter({ ymd: parsed.day, ...b });
      } else {
        setDayFilter(null);
      }
      if (!parsed.albumId) {
        // leave albumView; segment switch clears below
      }
      if (parsed.segment !== "places") setPlace(null);
      if (parsed.segment !== "albums") setAlbumView(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleSegmentChange = useCallback(
    (next) => {
      if (!SEGMENT_IDS.includes(next) || next === activeSegment) return;
      setPlace(null);
      setPlacesDrawMode(false);
      setAlbumView(null);
      setDayFilter(null);
      setDuplicatesView(false);
      setFilters({ ...EMPTY_FILTERS });
      window.location.hash = next;
      setSegment(next);
    },
    [activeSegment, setPlace, setPlacesDrawMode, setAlbumView, setDayFilter, setDuplicatesView, setFilters, setSegment],
  );

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const galleryStatus = useQuery({
    queryKey: ["gallery-status"],
    queryFn: () => getJson("/api/v1/gallery/status"),
    refetchInterval: (query) => (query.state.data?.busy ? 1500 : 8000),
  });
  const drivesEmpty =
    !drives.isLoading && Array.isArray(drives.data) && drives.data.length === 0;
  // Members may have shared albums with no folder grants — probe albums before
  // treating an empty drives list as “nothing to open.”
  const albums = useQuery({
    queryKey: ["gallery-albums"],
    queryFn: () => getJson("/api/v1/gallery/albums"),
    enabled:
      activeSegment === "albums" ||
      !!albumPick ||
      newAlbumOpen ||
      (!isAdmin && drivesEmpty),
  });
  const places = useQuery({
    queryKey: ["gallery-places"],
    queryFn: () => getJson("/api/v1/gallery/places"),
    enabled: activeSegment === "places" || filtersOpen,
  });

  // Toolbar / filter sheet dates → unix range (day filter wins when set).
  const rangeFromFilters = useMemo(() => {
    if (filters.undated) return null;
    if (!filters.dateFrom && !filters.dateTo) return null;
    const fromB = filters.dateFrom ? dayBoundsLocal(filters.dateFrom) : null;
    const toB = filters.dateTo ? dayBoundsLocal(filters.dateTo) : null;
    if (!fromB && !toB) return null;
    return {
      from: fromB?.from,
      to: toB?.to ?? fromB?.to,
      label:
        filters.dateFrom && filters.dateTo && filters.dateFrom !== filters.dateTo
          ? `${filters.dateFrom} → ${filters.dateTo}`
          : fromB?.label || toB?.label,
    };
  }, [filters.dateFrom, filters.dateTo, filters.undated]);

  const effectiveFrom = filters.undated ? undefined : dayFilter?.from ?? rangeFromFilters?.from;
  const effectiveTo = filters.undated ? undefined : dayFilter?.to ?? rangeFromFilters?.to;
  const filterPlaceBbox = filters.placeBbox?.length === 4 ? filters.placeBbox.join(",") : "";
  const placeBboxParam = filterPlaceBbox || place?.place_bbox?.join(",") || "";
  const filterActiveCount = countActiveFilters(filters);
  const filterChips = filterChipList(filters);

  const listKey = useMemo(
    () => [
      "gallery",
      activeSegment,
      search,
      place?.key || "",
      placeBboxParam,
      albumView ? `${albumView.home_drive_id}:${albumView.id}` : "",
      effectiveFrom ?? "",
      effectiveTo ?? "",
      filters.undated ? "1" : "",
      filters.kind || "",
      filters.cameraMake || "",
      filters.cameraModel || "",
      filters.orientation || "",
      filters.hasGps || "",
      filters.albumMembership || "",
      (filters.formats || []).join(","),
      filters.hourFrom || "",
      filters.hourTo || "",
      filters.isoMin || "",
      filters.isoMax || "",
      filters.focalMin || "",
      filters.focalMax || "",
      filters.flash || "",
      filters.minMegapixels || "",
      filters.minDuration || "",
      filters.maxDuration || "",
      filters.lens || "",
    ],
    [
      activeSegment,
      search,
      place,
      placeBboxParam,
      albumView,
      effectiveFrom,
      effectiveTo,
      filters,
    ],
  );

  const gallery = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getJson(
        galleryUrl({
          q: search || undefined,
          favorites: activeSegment === "favorites",
          archived: activeSegment === "archive",
          albumId: albumView?.id,
          albumHome: albumView?.home_drive_id,
          place: placeBboxParam ? undefined : place?.key,
          placeBbox: placeBboxParam || undefined,
          from: effectiveFrom,
          to: effectiveTo,
          kind: filters.kind || undefined,
          cameraMake: filters.cameraMake || undefined,
          cameraModel: filters.cameraModel || undefined,
          orientation: filters.orientation || undefined,
          hasGps: filters.hasGps || undefined,
          format: filters.formats?.length ? filters.formats.join(",") : undefined,
          hourFrom: filters.hourFrom || undefined,
          hourTo: filters.hourTo || undefined,
          isoMin: filters.isoMin || undefined,
          isoMax: filters.isoMax || undefined,
          focalMin: filters.focalMin || undefined,
          focalMax: filters.focalMax || undefined,
          flash: filters.flash || undefined,
          minMegapixels: filters.minMegapixels || undefined,
          minDuration: filters.minDuration || undefined,
          maxDuration: filters.maxDuration || undefined,
          lens: filters.lens || undefined,
          undated: filters.undated || undefined,
          albumMembership: filters.albumMembership || undefined,
          offset: pageParam,
        }),
      ),
    getNextPageParam: (last) => (last?.has_more ? last.next_offset : undefined),
    enabled: (activeSegment !== "places" || !!place || !!filterPlaceBbox) && !duplicatesView,
  });

  const duplicates = useQuery({
    queryKey: ["gallery-duplicates"],
    queryFn: () => getJson("/api/v1/gallery/duplicates?limit=50"),
    enabled: duplicatesView,
  });

  const duplicatePhotos = useMemo(
    () => (duplicates.data?.groups || []).flatMap((g) => g.items || []),
    [duplicates.data],
  );

  const photos = useMemo(
    () =>
      duplicatesView
        ? duplicatePhotos
        : (gallery.data?.pages || []).flatMap((p) => p.items || []),
    [duplicatesView, duplicatePhotos, gallery.data],
  );

  // Keep multi-select items in sync with visible photos.
  const selection = useMultiSelect({ items: photos });

  useEffect(() => {
    selection.exit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset when the segment changes
  }, [activeSegment]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && selection.selectMode) {
        selection.exit();
      }
      const tag = (e.target instanceof HTMLElement ? e.target.tagName : "") || "";
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (!typing && e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const memories = useQuery({
    queryKey: ["gallery-memories"],
    queryFn: async () => {
      const now = new Date();
      const yearsBack = 8;
      const start = new Date(now.getFullYear() - yearsBack, 0, 1);
      const data = await getJson(
        galleryUrl({
          from: Math.floor(start.getTime() / 1000),
          to: Math.floor(now.getTime() / 1000),
          offset: 0,
        }).replace("limit=80", "limit=200"),
      );
      const md = `${now.getMonth()}-${now.getDate()}`;
      return (data.items || []).filter((p) => {
        if (!p.taken_at) return false;
        const d = new Date(p.taken_at * 1000);
        return `${d.getMonth()}-${d.getDate()}` === md && d.getFullYear() !== now.getFullYear();
      });
    },
    enabled:
      activeSegment === "library" &&
      !dayFilter &&
      !albumView &&
      !place &&
      !search &&
      filterActiveCount === 0,
  });

  const indexing = !!galleryStatus.data?.busy;
  const foundCount = Number(galleryStatus.data?.found_count) || 0;
  const indexingDriveLabel =
    typeof galleryStatus.data?.drive_label === "string" && galleryStatus.data.drive_label.trim()
      ? galleryStatus.data.drive_label.trim()
      : null;
  const statusLastError =
    typeof galleryStatus.data?.last_error === "string" && galleryStatus.data.last_error.trim()
      ? galleryStatus.data.last_error.trim()
      : null;

  useEffect(() => {
    if (!indexing) return undefined;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-places"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    }, 2000);
    return () => clearInterval(id);
  }, [indexing, queryClient]);

  const wasIndexingRef = useRef(false);
  useEffect(() => {
    if (wasIndexingRef.current && !indexing) {
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-places"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-status"] });
    }
    wasIndexingRef.current = indexing;
  }, [indexing, queryClient]);

  const rescan = useMutation({
    mutationFn: () => postJson("/api/v1/gallery/rescan", {}),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["gallery-status"] });
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-places"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't look again. Try once more.")),
  });

  const driveList = drives.data || [];
  const albumList = Array.isArray(albums.data) ? albums.data : [];
  const looking = gallery.isLoading || (indexing && photos.length === 0);
  const noDrives = !drives.isLoading && driveList.length === 0;
  const memberAlbumsGatePending =
    !isAdmin &&
    noDrives &&
    (albums.isLoading || albums.isPending || (!albums.isFetched && !albums.isError));
  const memberAlbumOnly = !isAdmin && noDrives && !memberAlbumsGatePending && albumList.length > 0;
  const galleryLoadError =
    gallery.isError && !looking
      ? apiErrorMessage(gallery.error, "Luna couldn't open the gallery. Try again.")
      : null;
  const noPhotos =
    !looking &&
    !indexing &&
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    driveList.length > 0 &&
    activeSegment === "library" &&
    !search &&
    !place &&
    !albumView &&
    !dayFilter &&
    filterActiveCount === 0;
  const albumOnlyLibraryEmpty =
    memberAlbumOnly &&
    !looking &&
    !gallery.isLoading &&
    photos.length === 0 &&
    activeSegment === "library" &&
    !search &&
    !place &&
    !albumView &&
    !dayFilter &&
    filterActiveCount === 0;
  const filtersEmpty =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    driveList.length > 0 &&
    filterActiveCount > 0 &&
    (activeSegment === "library" ||
      activeSegment === "favorites" ||
      activeSegment === "archive" ||
      !!albumView ||
      !!place);
  const noFavorites =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    driveList.length > 0 &&
    activeSegment === "favorites" &&
    filterActiveCount === 0;
  const noArchive =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    driveList.length > 0 &&
    activeSegment === "archive" &&
    filterActiveCount === 0;
  const searchEmpty =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    !!search &&
    (activeSegment === "library" || activeSegment === "favorites" || activeSegment === "archive");
  const albumEmpty =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    !!albumView;
  const placeEmpty =
    !gallery.isLoading &&
    !gallery.isError &&
    photos.length === 0 &&
    !!place;

  const indexingProgress =
    indexing && foundCount > 0
      ? indexingDriveLabel
        ? `Found ${foundCount} ${foundCount === 1 ? "photo" : "photos"} on ${indexingDriveLabel}`
        : `Found ${foundCount} ${foundCount === 1 ? "photo" : "photos"}`
      : null;

  const favorite = useMutation({
    /** @param {{ drive_id: string, path: string, favorited?: boolean }} photo */
    mutationFn: async (photo) => {
      const body = { drive_id: photo.drive_id, path: photo.path };
      if (photo.favorited) {
        await deleteJson("/api/v1/gallery/favorites", {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await putJson("/api/v1/gallery/favorites", body);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gallery"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const archiveMut = useMutation({
    /** @param {object[]} items */
    mutationFn: async (items) => {
      for (const photo of items) {
        await putJson("/api/v1/gallery/archive", {
          drive_id: photo.drive_id,
          path: photo.path,
        });
      }
    },
    onSuccess: () => {
      selection.exit();
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const trash = useMutation({
    /** @param {{ drive_id: string, path: string }} photo */
    mutationFn: async (photo) => {
      await deleteJson(
        `/api/v1/drives/${photo.drive_id}/files?path=${encodeURIComponent(photo.path)}`,
      );
    },
    onSuccess: () => {
      setTrashPhoto(null);
      setLightbox(null);
      setUndoNotice("Moved to Trash. You can restore it from Files → Trash.");
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const trashMany = useMutation({
    /** @param {object[]} items */
    mutationFn: async (items) => {
      for (const photo of items) {
        await deleteJson(
          `/api/v1/drives/${photo.drive_id}/files?path=${encodeURIComponent(photo.path)}`,
        );
      }
    },
    onSuccess: (_d, items) => {
      setTrashBulk(null);
      selection.exit();
      setUndoNotice(
        items.length === 1
          ? "Moved to Trash. You can restore it from Files → Trash."
          : `Moved ${items.length} items to Trash. You can restore them from Files → Trash.`,
      );
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const createAlbum = useMutation({
    /** @param {{ name: string, items?: object[] }} args */
    mutationFn: async ({ name, items }) => {
      const album = await postJson("/api/v1/gallery/albums", { name });
      if (items?.length) {
        await postJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/items`, {
          items: items.map((p) => ({ drive_id: p.drive_id, path: p.path })),
        });
      }
      return album;
    },
    onSuccess: (album) => {
      haptic("success");
      setNewAlbumOpen(false);
      setNewAlbumName("");
      setNewAlbumSeed(null);
      selection.exit();
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      if (shareAfterCreate && album) {
        setShareAfterCreate(false);
        setShareAlbum(album);
      }
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });

  const setAlbumCover = useMutation({
    /** @param {object} photo */
    mutationFn: async (photo) => {
      if (!albumView) return;
      await patchJson(`/api/v1/gallery/albums/${albumView.home_drive_id}/${albumView.id}`, {
        cover_path: photo.path,
        cover_drive_id: photo.drive_id,
      });
    },
    onSuccess: () => {
      haptic("success");
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      setUndoNotice("Album cover updated.");
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Luna couldn't set that album cover."));
    },
  });

  const renameAlbumMut = useMutation({
    /** @param {{ album: object, name: string }} args */
    mutationFn: ({ album, name }) =>
      patchJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}`, { name }),
    onSuccess: (_d, { album, name }) => {
      haptic("success");
      setRenameAlbum(null);
      setAlbumView((cur) =>
        cur && cur.id === album.id ? { ...cur, name } : cur,
      );
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });

  const lockAlbumMut = useMutation({
    /** @param {{ album: object, locked: boolean }} args */
    mutationFn: ({ album, locked }) =>
      patchJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}`, { locked }),
    onSuccess: () => {
      haptic("success");
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });

  const deleteAlbum = useMutation({
    /** @param {{ home_drive_id: string, id: string }} album */
    mutationFn: (album) =>
      deleteJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}`),
    onSuccess: (_data, album) => {
      haptic("success");
      setTrashAlbum(null);
      setAlbumView((current) =>
        current && current.id === album.id && current.home_drive_id === album.home_drive_id
          ? null
          : current,
      );
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err));
    },
  });

  const addToAlbum = useMutation({
    /** @param {{ album: object, photos: object[], close?: () => void }} args */
    mutationFn: ({ album, photos: items }) =>
      postJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/items`, {
        items: items.map((p) => ({ drive_id: p.drive_id, path: p.path })),
      }),
    onSuccess: (_data, vars) => {
      if (vars.close) vars.close();
      else setAlbumPick(null);
      selection.exit();
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const removeFromAlbum = useMutation({
    /** @param {object[]} items */
    mutationFn: async (items) => {
      if (!albumView) return;
      for (const photo of items) {
        await deleteJson(
          `/api/v1/gallery/albums/${albumView.home_drive_id}/${albumView.id}/items`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ drive_id: photo.drive_id, path: photo.path }),
          },
        );
      }
    },
    onSuccess: () => {
      selection.exit();
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const bulkFavorite = useMutation({
    /** @param {object[]} items */
    mutationFn: async (items) => {
      for (const photo of items) {
        if (!photo.favorited) {
          await putJson("/api/v1/gallery/favorites", {
            drive_id: photo.drive_id,
            path: photo.path,
          });
        }
      }
    },
    onSuccess: () => {
      selection.exit();
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const uploadFiles = useMutation({
    /** @param {File[]} files */
    mutationFn: async (files) => {
      const writable = (drives.data || []).find(
        (d) => d.state === "as_is" && d.mount_point,
      ) || (drives.data || [])[0];
      if (!writable?.id) throw new Error("No drive to upload to.");
      // Prefer Photos / DCIM folders when present — upload API creates leaf path.
      const dest = "Photos";
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        await postForm(
          `/api/v1/drives/${writable.id}/files/upload?path=${encodeURIComponent(dest)}`,
          form,
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gallery"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-status"] });
      void rescan.mutate();
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't upload those photos. Try again.")),
  });

  async function downloadSelected(items) {
    try {
      // Prefer zip endpoint when backend agent adds it.
      const res = await fetch("/api/v1/gallery/download", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((p) => ({ drive_id: p.drive_id, path: p.path })),
        }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "photos.zip";
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
    } catch {
      /* sequential fallback */
    }
    for (const photo of items) {
      const a = document.createElement("a");
      a.href = downloadHref(photo.drive_id, photo.path);
      a.download = photo.name || "photo";
      a.click();
    }
  }

  const openPhoto = useCallback((photo) => {
    setLightboxOverride(null);
    setLightbox({ key: photoSelectionKey(photo) });
  }, []);

  const lightboxPhotos = lightboxOverride || photos;
  const lightboxIndex = lightbox
    ? Math.max(0, lightboxPhotos.findIndex((p) => photoSelectionKey(p) === lightbox.key))
    : 0;

  const loadMore = useCallback(() => {
    if (gallery.hasNextPage && !gallery.isFetchingNextPage) {
      gallery.fetchNextPage();
    }
  }, [gallery]);

  useEffect(() => {
    const id = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const handleQueryChange = useCallback(
    (e) => {
      const next = e.target.value;
      setQ(next);
      if (!next.trim()) return;
      setPlace(null);
      if (activeSegment === "places") handleSegmentChange("library");
    },
    [activeSegment, handleSegmentChange, setQ, setPlace],
  );

  function tryOpenAlbum(album) {
    if (album.locked) {
      try {
        if (sessionStorage.getItem(unlockKey(album)) === "1") {
          setAlbumView(album);
          return;
        }
      } catch {
        /* ignore */
      }
      setLockedGate(album);
      return;
    }
    setAlbumView(album);
  }

  // Page-level drag-drop upload on library.
  useEffect(() => {
    if (activeSegment !== "library" || albumView || place) return undefined;
    function onDragOver(e) {
      e.preventDefault();
    }
    function onDrop(e) {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter(
        (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
      );
      if (files.length) uploadFiles.mutate(files);
    }
    const node = dropZoneRef.current || document.body;
    node.addEventListener("dragover", onDragOver);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("drop", onDrop);
    };
  }, [activeSegment, albumView, place, uploadFiles]);

  const showTimeline =
    !duplicatesView &&
    (activeSegment === "library" ||
      activeSegment === "favorites" ||
      activeSegment === "archive" ||
      (activeSegment === "places" && place) ||
      (activeSegment === "albums" && albumView));

  const placesMapOverview = activeSegment === "places" && !place && !duplicatesView;

  const actionModalOpen =
    newAlbumOpen
    || albumPick != null
    || trashPhoto != null
    || trashBulk != null
    || sharePhoto != null
    || shareAlbum != null
    || renameAlbum != null
    || yearOpen
    || editPhoto != null
    || lockedGate != null
    || lightbox != null
    || filtersOpen
    || shortcutsOpen;

  const detailChrome =
    dayFilter ||
    place ||
    albumView ||
    rangeFromFilters ||
    filters.kind ||
    filters.undated ||
    filters.albumMembership ||
    duplicatesView;

  if (noDrives && !memberAlbumOnly) {
    if (memberAlbumsGatePending) {
      return (
        <Page title="Photos" titleId="gallery-title">
          <GalleryLoadingStatus label="Loading photos…" />
        </Page>
      );
    }
    return (
      <Page title="Photos" titleId="gallery-title">
        <EmptyState
          icon={PlugZap}
          title={isAdmin ? "No drives yet" : "No photos you can open yet"}
          description={
            isAdmin
              ? "Plug in a drive and add it on the Drives page. Luna will then look through it for photos. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
              : "Ask an Admin to share a drive, folder, or album with photos. Luna will show them here once you have access."
          }
          action={
            isAdmin ? (
              <Button variant="primary" asChild>
                <Link to="/drives">Go to Drives</Link>
              </Button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  return (
    <Page
      title="Photos"
      titleId="gallery-title"
      headerClassName="mb-8 shrink-0"
      className={
        placesMapOverview
          ? "flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden pb-6 xl:pb-[108px]"
          : undefined
      }
    >
      <div ref={dropZoneRef} className="shrink-0">
      <GalleryToolbar
        segments={SEGMENTS}
        segment={activeSegment}
        onSegmentChange={handleSegmentChange}
        query={q}
        onQueryChange={handleQueryChange}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        selectMode={selection.selectMode}
        onSelectModeChange={(on) => (on ? selection.enter() : selection.exit())}
        onOpenDates={() => setYearOpen(true)}
        onOpenFilters={() => {
          setFilterFocus("");
          setFiltersOpen(true);
        }}
        filterActiveCount={filterActiveCount}
        columns={columns}
        onColumnsChange={setColumns}
        showSelect={showTimeline || duplicatesView}
        onRescan={() => rescan.mutate()}
        rescanPending={rescan.isPending}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      {filterChips.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2" data-slot="gallery-filter-chips">
          {filterChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="inline-flex items-center gap-2 rounded-pill bg-secondary text-primary border-2 border-primary/20 px-3 py-1.5 text-sm font-mono hover:border-accent transition-colors"
              onClick={() => {
                haptic("light");
                setFilters((prev) => clearFilterChip(prev, chip.id));
                if (chip.id === "dates") setDayFilter(null);
              }}
              aria-label={`Remove filter ${chip.label}`}
            >
              <span className="max-w-[14rem] truncate">{chip.label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            surface="primary"
            onClick={() => {
              haptic("light");
              setFilters({ ...EMPTY_FILTERS });
              setDayFilter(null);
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      {showPageLevelError(error || galleryLoadError, actionModalOpen) && (
        <PageNotice variant="error" className="mb-4">
          {error || galleryLoadError}
        </PageNotice>
      )}
      {undoNotice && (
        <PageNotice variant="info" className="mb-4">
          <span className="flex flex-wrap items-center gap-2">
            {undoNotice}
            <Button variant="outline" size="sm" surface="primary" asChild>
              <Link to="/drives">Open Files</Link>
            </Button>
            <Button variant="ghost" size="sm" surface="primary" onClick={() => setUndoNotice(null)}>
              Dismiss
            </Button>
          </span>
        </PageNotice>
      )}

      {statusLastError && (activeSegment === "library" || photos.length > 0) && (
        <PageNotice variant="warning" className="mb-4">
          {statusLastError}
        </PageNotice>
      )}

      {gallery.isLoading && photos.length === 0 && activeSegment === "library" && (
        <GalleryLoadingStatus label="Loading library…" />
      )}

      {indexing && photos.length === 0 && !gallery.isLoading && activeSegment === "library" && (
        <Card className="mb-4">
          <p className="font-mono text-sm">Looking through your drives</p>
          <p className="mt-2 text-sm">
            Luna is finding photos in the background. They&apos;ll show up here as they&apos;re found.
          </p>
          {indexingProgress && <p className="mt-2 text-sm font-mono">{indexingProgress}</p>}
        </Card>
      )}

      {indexing && photos.length > 0 && activeSegment === "library" && indexingProgress && (
        <p className="mb-3 text-sm font-mono" role="status" aria-live="polite">
          {indexingProgress}
        </p>
      )}

      {activeSegment === "library" && !detailChrome && (memories.data?.length || 0) > 0 && (
        <Card className="mb-4" data-slot="memories-card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={16} aria-hidden="true" />
              <p className="font-mono text-sm">On this day</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              surface="secondary"
              onClick={() => {
                const list = memories.data || [];
                const first = list[0];
                if (!first) return;
                setLightboxOverride(list);
                setLightbox({ key: photoSelectionKey(first) });
                setSlideshow(true);
              }}
            >
              Play
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
            {memories.data.slice(0, 12).map((photo, index) => (
              <PhotoThumb
                key={photoSelectionKey(photo)}
                photo={photo}
                index={index}
                onOpen={(p) => {
                  setLightboxOverride(memories.data || []);
                  setLightbox({ key: photoSelectionKey(p) });
                }}
              />
            ))}
          </div>
        </Card>
      )}

      {noPhotos && (
        <EmptyState
          icon={ImageIcon}
          title="No photos yet"
          description="Add pictures to a drive and Luna will show them here. You can also drop photos onto this page. If you already added some, try looking again."
          action={
            <Button
              variant="primary"
              loading={rescan.isPending}
              onClick={() => rescan.mutate()}
            >
              Look again
            </Button>
          }
        />
      )}

      {albumOnlyLibraryEmpty && (
        <EmptyState
          icon={ImageIcon}
          title="Shared photos are in Albums"
          description="An Admin shared albums with you. Open Albums to see them."
          action={
            <Button variant="primary" onClick={() => handleSegmentChange("albums")}>
              Open Albums
            </Button>
          }
        />
      )}

      {searchEmpty && (
        <EmptyState
          icon={ImageIcon}
          title="No matches"
          description={`Nothing matched “${search}”. Try another word or clear the search.`}
        />
      )}

      {gallery.isLoading && photos.length === 0 && activeSegment === "favorites" && (
        <GalleryLoadingStatus label="Loading favorites…" />
      )}

      {noFavorites && (
        <EmptyState
          icon={ImageIcon}
          title="No favorites yet"
          description="Open a photo and tap the heart to save it here."
        />
      )}

      {noArchive && (
        <EmptyState
          icon={ImageIcon}
          title="Archive is empty"
          description="Archived photos are hidden from Library. Select photos and choose Archive to move them here."
        />
      )}

      {activeSegment === "albums" && !albumView && !duplicatesView && (
        <AlbumsPanel
          albums={albums.data || []}
          loading={albums.isLoading}
          currentUser={user}
          onOpen={tryOpenAlbum}
          onCreate={() => setNewAlbumOpen(true)}
          onDelete={(album) => {
            setError(null);
            setTrashAlbum(album);
          }}
          onShare={(album) => {
            setError(null);
            setShareAlbum(album);
          }}
          onRename={(album) => {
            setRenameAlbum(album);
            setRenameValue(album.name || "");
          }}
          onLock={(album) => lockAlbumMut.mutate({ album, locked: !album.locked })}
          onSmart={(smart) => {
            if (smart === "duplicates") {
              setDuplicatesView(true);
              setAlbumView(null);
              setPlace(null);
              setDayFilter(null);
              setFilters({ ...EMPTY_FILTERS });
              setSegment("albums");
              return;
            }
            handleSegmentChange("library");
            if (smart === "videos") {
              setFilters((prev) => ({ ...EMPTY_FILTERS, ...prev, kind: "video" }));
            }
            if (smart === "screenshots") {
              setFilters({ ...EMPTY_FILTERS });
              setQ("Screenshot");
              setSearch("Screenshot");
              setSearchOpen(true);
            }
            if (smart === "last30") {
              const toDate = new Date();
              const fromDate = new Date(Date.now() - 30 * 86400 * 1000);
              const toYmd = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, "0")}-${String(toDate.getDate()).padStart(2, "0")}`;
              const fromYmd = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, "0")}-${String(fromDate.getDate()).padStart(2, "0")}`;
              setDayFilter(null);
              setFilters((prev) => ({
                ...EMPTY_FILTERS,
                ...prev,
                dateFrom: fromYmd,
                dateTo: toYmd,
              }));
            }
          }}
        />
      )}

      {placesMapOverview && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant={placesDrawMode ? "accent" : "outline"}
              surface="primary"
              onClick={() => {
                haptic("selection");
                setPlacesDrawMode((prev) => !prev);
              }}
            >
              {placesDrawMode ? "Exit draw mode" : "Draw a custom area…"}
            </Button>
          </div>
          <PlacesMap
            places={places.data || []}
            loading={places.isLoading}
            drawMode={placesDrawMode}
            onDrawModeChange={setPlacesDrawMode}
            onSelect={(p) => {
              setPlace(p);
              setPlacesDrawMode(false);
            }}
          />
        </div>
      )}

      {detailChrome && (
        <div
          key={
            dayFilter?.ymd
            || place?.key
            || (albumView ? `${albumView.home_drive_id}:${albumView.id}` : "detail")
            || (duplicatesView ? "duplicates" : null)
            || filters.kind
            || rangeFromFilters?.label
            || "filter"
          }
          data-slot="gallery-detail-chrome"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 animate-nav-slide-in"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="outline"
              surface="primary"
              onClick={() => {
                setPlace(null);
                setAlbumView(null);
                setDayFilter(null);
                setDuplicatesView(false);
                setFilters({ ...EMPTY_FILTERS });
                setQ("");
                setSearch("");
              }}
            >
              Back
            </Button>
            <p className="font-mono text-sm truncate">
              {duplicatesView
                ? "Possible duplicates"
                : dayFilter?.label
                || place?.label
                || albumView?.name
                || rangeFromFilters?.label
                || (filters.undated ? "Undated" : null)
                || (filters.albumMembership === "none" ? "Not in an album" : null)
                || (filters.albumMembership === "any" ? "In an album" : null)
                || (filters.kind === "video" ? "Videos" : null)
                || (filters.kind === "image" ? "Photos" : null)
                || search}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {place && (
              <>
                <Button
                  variant="secondary"
                  surface="primary"
                  size="sm"
                  onClick={() => {
                    setNewAlbumSeed(photos);
                    setNewAlbumName(place.label || "Place");
                    setNewAlbumOpen(true);
                  }}
                >
                  Album from place
                </Button>
                <Button
                  variant="outline"
                  surface="primary"
                  size="sm"
                  onClick={() => {
                    setFilterFocus("where");
                    setFiltersOpen(true);
                  }}
                >
                  Draw a custom area…
                </Button>
              </>
            )}
            {dayFilter && (
              <Button
                variant="secondary"
                surface="primary"
                size="sm"
                onClick={() => {
                  setNewAlbumSeed(photos);
                  setNewAlbumName(dayFilter.label);
                  setNewAlbumOpen(true);
                }}
              >
                Album from day
              </Button>
            )}
            {albumView && canManageAlbum(albumView, user) && (
              <>
                <Button
                  variant="secondary"
                  surface="primary"
                  size="sm"
                  onClick={() => {
                    setRenameAlbum(albumView);
                    setRenameValue(albumView.name || "");
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="secondary"
                  surface="primary"
                  onClick={() => {
                    setError(null);
                    setShareAlbum(albumView);
                  }}
                >
                  Share album
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {albumView && canManageAlbum(albumView, user) && <AlbumMembersPanel album={albumView} />}

      {albumEmpty && (
        <EmptyState
          icon={ImageIcon}
          title="This album is empty"
          description="Add photos from the library, or share the album so others can contribute."
        />
      )}
      {placeEmpty && (
        <EmptyState
          icon={ImageIcon}
          title="No photos here"
          description="Luna didn't find photos for this place yet."
        />
      )}

      {filtersEmpty && (
        <EmptyState
          icon={ImageIcon}
          title="No photos match these filters"
          description="Try clearing a filter chip, or clear all filters and look again."
          action={
            <Button
              variant="primary"
              onClick={() => {
                setFilters({ ...EMPTY_FILTERS });
                setDayFilter(null);
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {showTimeline && photos.length > 0 && (
        <PhotoTimeline
          photos={photos}
          hasMore={!!gallery.hasNextPage}
          loadingMore={gallery.isFetchingNextPage}
          onLoadMore={loadMore}
          onOpen={openPhoto}
          selectMode={selection.selectMode}
          selectedKeys={selection.selected}
          onToggle={selection.toggle}
          onLongPress={(photo) => {
            selection.enter();
            selection.toggle(photo);
          }}
          onFavoriteToggle={(photo) => favorite.mutate(photo)}
          onDayClick={(ymd, label) => {
            const b = dayBoundsLocal(ymd);
            if (!b) return;
            setDayFilter({ ymd, ...b, label: label || b.label });
            setFilters((prev) => ({ ...prev, dateFrom: "", dateTo: "", undated: false }));
          }}
          onSelectDay={(dayPhotos) => selection.selectItems(dayPhotos)}
          columns={/** @type {3|4|5|6} */ (columns)}
        />
      )}

      {duplicatesView && (
        <div className="space-y-6" data-slot="duplicates-view">
          {duplicates.isLoading && <GalleryLoadingStatus label="Looking for duplicates…" />}
          {duplicates.isError && (
            <EmptyState
              icon={ImageIcon}
              title="Couldn't check for duplicates"
              description="Try again in a moment."
            />
          )}
          {!duplicates.isLoading && !duplicates.isError && (duplicates.data?.groups || []).length === 0 && (
            <EmptyState
              icon={ImageIcon}
              title="No possible duplicates"
              description="Luna didn't find photos that share the same name and size."
            />
          )}
          {(duplicates.data?.groups || []).map((group) => (
            <div key={group.key} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-sm">
                  {group.name} · {group.items?.length || 0} copies
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  surface="primary"
                  onClick={() => selection.selectItems(group.items || [])}
                >
                  Select group
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                {(group.items || []).map((photo, index) => (
                  <PhotoThumb
                    key={photoSelectionKey(photo)}
                    photo={photo}
                    index={index}
                    selected={selection.selected.has(photoSelectionKey(photo))}
                    selectMode={selection.selectMode}
                    onOpen={selection.selectMode ? undefined : openPhoto}
                    onToggle={selection.toggle}
                    onLongPress={(p) => {
                      selection.enter();
                      selection.toggle(p);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selection.selectMode && selection.selectedCount > 0 && (
        <div className="mb-20 flex justify-center">
          <Button variant="outline" size="sm" surface="primary" onClick={selection.selectAllInView}>
            Select all in view
          </Button>
        </div>
      )}

      <SelectionActionBar
        count={selection.selectedCount}
        favoriting={bulkFavorite.isPending}
        archiving={archiveMut.isPending}
        busy={trashMany.isPending || removeFromAlbum.isPending || addToAlbum.isPending}
        onClear={selection.clear}
        onFavorite={() => bulkFavorite.mutate(selection.selectedItems)}
        onAddToAlbum={() => setAlbumPick(selection.selectedItems)}
        onNewAlbum={() => {
          setShareAfterCreate(false);
          setNewAlbumSeed(selection.selectedItems);
          setNewAlbumOpen(true);
        }}
        onRemoveFromAlbum={
          albumView
            ? () => removeFromAlbum.mutate(selection.selectedItems)
            : undefined
        }
        onShare={() => {
          setShareAfterCreate(true);
          setNewAlbumSeed(selection.selectedItems);
          setNewAlbumName(
            selection.selectedCount === 1
              ? selection.selectedItems[0]?.name?.replace(/\.[^.]+$/, "") || "Shared photos"
              : `Shared ${selection.selectedCount} photos`,
          );
          setNewAlbumOpen(true);
        }}
        onDownload={() => downloadSelected(selection.selectedItems)}
        onArchive={() => archiveMut.mutate(selection.selectedItems)}
        onTrash={() => setTrashBulk(selection.selectedItems)}
      />

      {lightbox && (
        <PhotoLightbox
          photos={lightboxPhotos}
          photoKey={lightbox.key}
          index={lightboxIndex}
          onClose={() => {
            setLightbox(null);
            setLightboxOverride(null);
            setSlideshow(false);
          }}
          onIndexChange={(i) => {
            const next = lightboxPhotos[i];
            if (next) setLightbox({ key: photoSelectionKey(next) });
          }}
          onFavorite={(p) => favorite.mutate(p)}
          onShare={setSharePhoto}
          onAlbum={(p) => setAlbumPick([p])}
          onTrash={setTrashPhoto}
          onEdit={setEditPhoto}
          onSetCover={albumView ? (p) => setAlbumCover.mutate(p) : undefined}
          slideshow={slideshow}
          onSlideshowChange={setSlideshow}
          favoriting={favorite.isPending}
        />
      )}

      {sharePhoto && (
        <CreateShareModal
          driveId={sharePhoto.drive_id}
          path={sharePhoto.path}
          onClose={() => setSharePhoto(null)}
          onDone={() => setSharePhoto(null)}
          onError={setError}
          overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
        />
      )}

      <ConfirmModal
        open={!!trashPhoto}
        onClose={() => {
          setTrashPhoto(null);
          setError(null);
        }}
        onConfirm={() => trashPhoto && trash.mutate(trashPhoto)}
        title="Move to trash?"
        message="Luna will move this file to Trash on its drive. You can restore it from Files later."
        variant="danger-undoable"
        confirmLabel="Move to trash"
        loading={trash.isPending}
        error={trashPhoto ? error : null}
        overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
      />

      <ConfirmModal
        open={!!trashBulk}
        onClose={() => {
          setTrashBulk(null);
          setError(null);
        }}
        onConfirm={() => trashBulk && trashMany.mutate(trashBulk)}
        title="Move selected to trash?"
        message={`Luna will move ${trashBulk?.length || 0} items to Trash. You can restore them from Files later.`}
        variant="danger-undoable"
        confirmLabel="Move to trash"
        loading={trashMany.isPending}
        error={trashBulk ? error : null}
      />

      <ConfirmModal
        open={!!trashAlbum}
        onClose={() => {
          setTrashAlbum(null);
          setError(null);
        }}
        onConfirm={() => trashAlbum && deleteAlbum.mutate(trashAlbum)}
        title="Delete album?"
        message={`Delete "${trashAlbum?.name || "this album"}"? Photos stay in your library — only this album is removed.`}
        variant="danger"
        confirmLabel="Delete album"
        icon={Trash2}
        loading={deleteAlbum.isPending}
        error={trashAlbum ? error : null}
      />

      <ConfirmModal
        open={!!lockedGate}
        onClose={() => setLockedGate(null)}
        onConfirm={() => {
          if (!lockedGate) return;
          try {
            sessionStorage.setItem(unlockKey(lockedGate), "1");
          } catch {
            /* ignore */
          }
          setAlbumView(lockedGate);
          setLockedGate(null);
        }}
        title="Private album"
        message={`"${lockedGate?.name || "This album"}" is marked private. Open it for this browser session?`}
        confirmLabel="Open album"
      />

      {newAlbumOpen && (
        <ModalCard title="New album" onClose={() => {
          setNewAlbumOpen(false);
          setNewAlbumSeed(null);
          setShareAfterCreate(false);
          setError(null);
        }}>
          {({ close }) => (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                createAlbum.mutate({
                  name: newAlbumName.trim(),
                  items: newAlbumSeed || undefined,
                });
              }}
            >
              <ShakeTarget shake={error}>
                <label className="block text-sm">
                  Album name
                  <input
                    value={newAlbumName}
                    onChange={(e) => setNewAlbumName(e.target.value)}
                    placeholder="e.g. Family Trip to Beijing"
                    className="mt-1 w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 focus:border-accent focus:outline-none"
                    autoFocus
                    required
                  />
                </label>
              </ShakeTarget>
              {newAlbumSeed?.length ? (
                <p className="text-sm">
                  Adds {newAlbumSeed.length} selected {newAlbumSeed.length === 1 ? "photo" : "photos"}.
                </p>
              ) : null}
              <ModalErrorNotice error={error} />
              <div className="flex gap-2">
                <Button type="submit" variant="accent" loading={createAlbum.isPending}>
                  Create
                </Button>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </ModalCard>
      )}

      {renameAlbum && (
        <ModalCard title="Rename album" onClose={() => setRenameAlbum(null)}>
          {({ close }) => (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                renameAlbumMut.mutate({ album: renameAlbum, name: renameValue.trim() });
              }}
            >
              <label className="block text-sm">
                Album name
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="mt-1 w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 focus:border-accent focus:outline-none"
                  required
                  autoFocus
                />
              </label>
              <ModalErrorNotice error={error} />
              <div className="flex gap-2">
                <Button type="submit" variant="accent" loading={renameAlbumMut.isPending}>
                  Save
                </Button>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </ModalCard>
      )}

      <AddToAlbumModal
        open={!!albumPick}
        albums={albums.data || []}
        albumsLoading={!!albumPick && (albums.isLoading || albums.isPending || (albums.isFetching && !albums.data))}
        adding={addToAlbum.isPending}
        error={albumPick ? error : null}
        overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
        onClose={() => {
          setAlbumPick(null);
          setError(null);
        }}
        onAdd={(album, close) => {
          if (!albumPick?.length) return;
          addToAlbum.mutate({ album, photos: albumPick, close });
        }}
      />

      <ShareAlbumModal
        open={!!shareAlbum}
        album={shareAlbum}
        overlayClassName={ABOVE_LIGHTBOX_OVERLAY_CLASS}
        onClose={() => setShareAlbum(null)}
      />

      <YearScrubber
        open={yearOpen}
        onClose={() => setYearOpen(false)}
        photos={photos}
        onPick={(range) => {
          if (range.kind === "day") {
            const d = new Date(range.from * 1000);
            const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            setDayFilter({ ymd, from: range.from, to: range.to, label: range.label });
            setFilters((prev) => ({ ...prev, dateFrom: "", dateTo: "" }));
          } else {
            setDayFilter(null);
            const fromD = new Date(range.from * 1000);
            const toD = new Date(range.to * 1000);
            const fromYmd = `${fromD.getFullYear()}-${String(fromD.getMonth() + 1).padStart(2, "0")}-${String(fromD.getDate()).padStart(2, "0")}`;
            const toYmd = `${toD.getFullYear()}-${String(toD.getMonth() + 1).padStart(2, "0")}-${String(toD.getDate()).padStart(2, "0")}`;
            setFilters((prev) => ({
              ...prev,
              dateFrom: fromYmd,
              dateTo: toYmd,
            }));
          }
          if (activeSegment !== "library") handleSegmentChange("library");
        }}
      />

      <GalleryFilterSheet
        open={filtersOpen}
        value={filters}
        places={places.data || []}
        focusSection={filterFocus}
        onClose={() => {
          setFiltersOpen(false);
          setFilterFocus("");
        }}
        onOpenDates={() => {
          setFiltersOpen(false);
          setFilterFocus("");
          setYearOpen(true);
        }}
        onApply={(next) => {
          setDayFilter(null);
          setDuplicatesView(false);
          setFilters({ ...EMPTY_FILTERS, ...next, formats: [...(next.formats || [])] });
          setFiltersOpen(false);
          setFilterFocus("");
          if (activeSegment === "places" && next.placeBbox?.length === 4) {
            setPlace(null);
          }
        }}
      />

      <ModalCard
        open={shortcutsOpen}
        title="Keyboard shortcuts"
        size="sm"
        onClose={() => setShortcutsOpen(false)}
      >
        <ul className="space-y-3 text-sm" data-slot="gallery-shortcuts">
          <li className="flex justify-between gap-4">
            <span>Search</span>
            <kbd className="font-mono rounded-pill bg-primary text-secondary px-2 py-0.5">/</kbd>
          </li>
          <li className="flex justify-between gap-4">
            <span>Clear / close</span>
            <kbd className="font-mono rounded-pill bg-primary text-secondary px-2 py-0.5">Esc</kbd>
          </li>
          <li className="flex justify-between gap-4">
            <span>Select mode</span>
            <span className="font-mono text-xs">Long-press a photo</span>
          </li>
          <li className="flex justify-between gap-4">
            <span>Favorite in lightbox</span>
            <kbd className="font-mono rounded-pill bg-primary text-secondary px-2 py-0.5">f</kbd>
          </li>
          <li className="flex justify-between gap-4">
            <span>Previous / next</span>
            <span className="font-mono text-xs">← →</span>
          </li>
          <li className="flex justify-between gap-4">
            <span>Move to trash</span>
            <kbd className="font-mono rounded-pill bg-primary text-secondary px-2 py-0.5">Delete</kbd>
          </li>
        </ul>
      </ModalCard>

      <PhotoEditModal
        open={!!editPhoto}
        photo={editPhoto}
        onClose={() => setEditPhoto(null)}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["gallery"] });
          setEditPhoto(null);
        }}
      />
      </div>
    </Page>
  );
}

function GalleryLoadingStatus({ label }) {
  return (
    <div
      className="flex items-center justify-center gap-3 py-20 text-secondary"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-mono">{label}</p>
      <Spinner size="lg" decorative className="text-secondary" />
    </div>
  );
}

GalleryLoadingStatus.propTypes = {
  label: PropTypes.string.isRequired,
};

function AlbumsPanel({
  albums,
  loading,
  currentUser,
  onOpen,
  onCreate,
  onShare,
  onDelete,
  onRename,
  onLock,
  onSmart,
}) {
  const [sort, setSort] = useState("newest");
  const sorted = useMemo(() => {
    const list = [...(albums || [])];
    if (sort === "oldest") list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    else if (sort === "name") {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
    } else if (sort === "most") {
      list.sort((a, b) => (b.item_count || 0) - (a.item_count || 0));
    } else {
      list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    }
    return list;
  }, [albums, sort]);

  if (loading) {
    return <GalleryLoadingStatus label="Loading albums…" />;
  }
  return (
    <div className="space-y-6">
      <div className="space-y-3" data-slot="smart-albums">
        <p className="font-mono text-sm">Smart albums</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" surface="primary" size="sm" onClick={() => onSmart("videos")}>
            <Film size={14} /> Videos
          </Button>
          <Button variant="secondary" surface="primary" size="sm" onClick={() => onSmart("last30")}>
            Last 30 days
          </Button>
          <Button variant="secondary" surface="primary" size="sm" onClick={() => onSmart("screenshots")}>
            Screenshots
          </Button>
          <Button variant="secondary" surface="primary" size="sm" onClick={() => onSmart("duplicates")}>
            Possible duplicates
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Dropdown
          options={[
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
            { value: "name", label: "Name" },
            { value: "most", label: "Most photos" },
          ]}
          value={sort}
          onChange={setSort}
          bg="primary"
          aria-label="Sort albums"
        />
        <Button variant="secondary" surface="primary" onClick={onCreate}>
          <Plus size={16} /> New album
        </Button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No albums yet"
          description="Create an album to group photos, or share one so others can add pictures too."
          action={
            <Button variant="primary" onClick={onCreate}>
              New album
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {sorted.map((album, index) => {
            const manage = canManageAlbum(album, currentUser);
            return (
            <div
              key={`${album.home_drive_id}-${album.id}`}
              className="rounded-large-element bg-secondary text-primary overflow-hidden animate-cascade-in motion-reduce:animate-none"
              style={{
                animationDelay: `${Math.min(index, 30) * 35}ms`,
                animationFillMode: "backwards",
              }}
              data-slot="album-card"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => {
                  haptic("medium");
                  onOpen(album);
                }}
              >
                <div className="aspect-square bg-primary text-secondary relative">
                  {album.cover_thumb ? (
                    <img src={album.cover_thumb} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center">
                      <ImageIcon size={24} />
                    </span>
                  )}
                  {album.locked && (
                    <span className="absolute top-2 right-2 rounded-pill bg-primary text-secondary p-1.5">
                      <Lock size={14} aria-label="Private album" />
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <p className="font-mono text-sm truncate">{album.name}</p>
                  <p className="text-xs mt-1">
                    {album.item_count} {album.item_count === 1 ? "item" : "items"}
                    {album.shared ? " · Shared" : ""}
                    {!manage ? " · Shared with you" : ""}
                  </p>
                </div>
              </button>
              {manage ? (
              <div className="px-3 pb-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-0 flex-1"
                  onClick={() => onShare(album)}
                >
                  Share album
                </Button>
                <Button
                  variant="ghost"
                  size="iconSm"
                  surface="secondary"
                  className="shrink-0"
                  aria-label={`Rename album ${album.name}`}
                  onClick={() => onRename(album)}
                >
                  <Pencil size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSm"
                  surface="secondary"
                  className="shrink-0"
                  aria-label={album.locked ? `Unlock album ${album.name}` : `Lock album ${album.name}`}
                  onClick={() => onLock(album)}
                >
                  <Lock size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSm"
                  surface="secondary"
                  className="shrink-0"
                  aria-label={`Delete album ${album.name}`}
                  onClick={() => onDelete(album)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              </div>
              ) : null}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

AlbumsPanel.propTypes = {
  albums: PropTypes.array,
  loading: PropTypes.bool,
  currentUser: PropTypes.shape({
    id: PropTypes.string,
    role: PropTypes.string,
  }),
  onOpen: PropTypes.func,
  onCreate: PropTypes.func,
  onShare: PropTypes.func,
  onDelete: PropTypes.func,
  onRename: PropTypes.func,
  onLock: PropTypes.func,
  onSmart: PropTypes.func,
};
