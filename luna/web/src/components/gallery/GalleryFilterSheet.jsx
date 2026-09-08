import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import Dropdown from "../common/Dropdown.jsx";
import { InfoHint, TermHint } from "../ui/Tooltip.jsx";
import GeozoneMap from "./GeozoneMap.jsx";
import { getJson } from "../../lib/api";

export const SAVED_FILTERS_KEY = "luna.photos.savedFilters";

/** @typedef {{
 *   dateFrom?: string,
 *   dateTo?: string,
 *   undated?: boolean,
 *   placeBbox?: [number, number, number, number]|null,
 *   cameraMake?: string,
 *   cameraModel?: string,
 *   lens?: string,
 *   isoMin?: string,
 *   isoMax?: string,
 *   focalMin?: string,
 *   focalMax?: string,
 *   flash?: ""|"on"|"off"|"any",
 *   kind?: ""|"image"|"video",
 *   orientation?: ""|"landscape"|"portrait"|"square",
 *   formats?: string[],
 *   hasGps?: ""|"yes"|"no"|"any",
 *   albumMembership?: ""|"any"|"none",
 *   minMegapixels?: string,
 *   minDuration?: string,
 *   maxDuration?: string,
 *   hourFrom?: string,
 *   hourTo?: string,
 *   timePreset?: ""|"morning"|"afternoon"|"evening"|"night",
 * }} GalleryFilters */

export const EMPTY_FILTERS = /** @type {GalleryFilters} */ ({
  dateFrom: "",
  dateTo: "",
  undated: false,
  placeBbox: null,
  cameraMake: "",
  cameraModel: "",
  lens: "",
  isoMin: "",
  isoMax: "",
  focalMin: "",
  focalMax: "",
  flash: "",
  kind: "",
  orientation: "",
  formats: [],
  hasGps: "",
  albumMembership: "",
  minMegapixels: "",
  minDuration: "",
  maxDuration: "",
  hourFrom: "",
  hourTo: "",
  timePreset: "",
});

/**
 * Count how many filter dimensions are active (for toolbar badge / chips).
 * @param {GalleryFilters|null|undefined} filters
 */
export function countActiveFilters(filters) {
  if (!filters) return 0;
  let n = 0;
  if (filters.undated) n += 1;
  else if (filters.dateFrom || filters.dateTo) n += 1;
  if (filters.placeBbox?.length === 4) n += 1;
  if (filters.cameraMake || filters.cameraModel) n += 1;
  if (filters.lens) n += 1;
  if (filters.isoMin || filters.isoMax) n += 1;
  if (filters.focalMin || filters.focalMax) n += 1;
  if (filters.flash && filters.flash !== "any") n += 1;
  if (filters.kind) n += 1;
  if (filters.orientation) n += 1;
  if (filters.formats?.length) n += 1;
  if (filters.hasGps && filters.hasGps !== "any") n += 1;
  if (filters.albumMembership === "any" || filters.albumMembership === "none") n += 1;
  if (filters.minMegapixels) n += 1;
  if (filters.minDuration || filters.maxDuration) n += 1;
  if (
    filters.timePreset ||
    (filters.hourFrom !== "" && filters.hourFrom != null) ||
    (filters.hourTo !== "" && filters.hourTo != null)
  ) {
    n += 1;
  }
  return n;
}

/**
 * @param {GalleryFilters} filters
 * @returns {Array<{ id: string, label: string }>}
 */
export function filterChipList(filters) {
  /** @type {Array<{ id: string, label: string }>} */
  const chips = [];
  if (!filters) return chips;
  if (filters.undated) {
    chips.push({ id: "dates", label: "Undated" });
  } else if (filters.dateFrom || filters.dateTo) {
    const a = filters.dateFrom || "…";
    const b = filters.dateTo || "…";
    chips.push({ id: "dates", label: a === b ? a : `${a} → ${b}` });
  }
  if (filters.placeBbox?.length === 4) {
    chips.push({ id: "placeBbox", label: "Map area" });
  }
  if (filters.cameraMake || filters.cameraModel) {
    chips.push({
      id: "camera",
      label: [filters.cameraMake, filters.cameraModel].filter(Boolean).join(" "),
    });
  }
  if (filters.lens) chips.push({ id: "lens", label: `Lens: ${filters.lens}` });
  if (filters.isoMin || filters.isoMax) {
    chips.push({
      id: "iso",
      label: `ISO ${filters.isoMin || "…"}–${filters.isoMax || "…"}`,
    });
  }
  if (filters.focalMin || filters.focalMax) {
    chips.push({
      id: "focal",
      label: `${filters.focalMin || "…"}–${filters.focalMax || "…"} mm`,
    });
  }
  if (filters.flash && filters.flash !== "any") {
    chips.push({ id: "flash", label: filters.flash === "on" ? "Flash on" : "Flash off" });
  }
  if (filters.kind === "image") chips.push({ id: "kind", label: "Photos" });
  if (filters.kind === "video") chips.push({ id: "kind", label: "Videos" });
  if (filters.orientation) {
    chips.push({
      id: "orientation",
      label: filters.orientation[0].toUpperCase() + filters.orientation.slice(1),
    });
  }
  if (filters.formats?.length) {
    chips.push({ id: "formats", label: filters.formats.join(", ").toUpperCase() });
  }
  if (filters.hasGps === "yes") chips.push({ id: "hasGps", label: "Has location" });
  if (filters.hasGps === "no") chips.push({ id: "hasGps", label: "No location" });
  if (filters.albumMembership === "any") {
    chips.push({ id: "albumMembership", label: "In an album" });
  }
  if (filters.albumMembership === "none") {
    chips.push({ id: "albumMembership", label: "Not in an album" });
  }
  if (filters.minMegapixels) {
    chips.push({ id: "minMegapixels", label: `≥ ${filters.minMegapixels} MP` });
  }
  if (filters.minDuration || filters.maxDuration) {
    chips.push({
      id: "duration",
      label: `Video ${filters.minDuration || "0"}–${filters.maxDuration || "∞"} s`,
    });
  }
  if (filters.timePreset) {
    const labels = {
      morning: "Morning",
      afternoon: "Afternoon",
      evening: "Evening",
      night: "Night",
    };
    chips.push({ id: "timeOfDay", label: labels[filters.timePreset] || "Time of day" });
  } else if (filters.hourFrom !== "" || filters.hourTo !== "") {
    chips.push({
      id: "timeOfDay",
      label: `${filters.hourFrom || "0"}–${filters.hourTo || "24"}h`,
    });
  }
  return chips;
}

/**
 * @param {GalleryFilters} filters
 * @param {string} chipId
 */
export function clearFilterChip(filters, chipId) {
  const next = { ...filters, formats: [...(filters.formats || [])] };
  switch (chipId) {
    case "dates":
      next.dateFrom = "";
      next.dateTo = "";
      next.undated = false;
      break;
    case "placeBbox":
      next.placeBbox = null;
      break;
    case "camera":
      next.cameraMake = "";
      next.cameraModel = "";
      break;
    case "lens":
      next.lens = "";
      break;
    case "iso":
      next.isoMin = "";
      next.isoMax = "";
      break;
    case "focal":
      next.focalMin = "";
      next.focalMax = "";
      break;
    case "flash":
      next.flash = "";
      break;
    case "kind":
      next.kind = "";
      break;
    case "orientation":
      next.orientation = "";
      break;
    case "formats":
      next.formats = [];
      break;
    case "hasGps":
      next.hasGps = "";
      break;
    case "albumMembership":
      next.albumMembership = "";
      break;
    case "minMegapixels":
      next.minMegapixels = "";
      break;
    case "duration":
      next.minDuration = "";
      next.maxDuration = "";
      break;
    case "timeOfDay":
      next.timePreset = "";
      next.hourFrom = "";
      next.hourTo = "";
      break;
    default:
      break;
  }
  return next;
}

function readSavedFilters() {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedFilters(list) {
  try {
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const TIME_PRESETS = {
  morning: { from: "5", to: "11", label: "Morning (5–11)" },
  afternoon: { from: "11", to: "17", label: "Afternoon" },
  evening: { from: "17", to: "21", label: "Evening" },
  night: { from: "21", to: "5", label: "Night" },
};

/** @returns {{ from: string, to: string }} */
export function datePresetRange(preset) {
  const now = new Date();
  const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (preset === "last7") {
    const from = new Date(now.getTime() - 6 * 86400 * 1000);
    return { from: ymd(from), to: ymd(now) };
  }
  if (preset === "thisMonth") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: ymd(from), to: ymd(now) };
  }
  if (preset === "thisYear") {
    const from = new Date(now.getFullYear(), 0, 1);
    return { from: ymd(from), to: ymd(now) };
  }
  return { from: "", to: "" };
}

const inputClass =
  "w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none no-focus-outline";

const sectionClass = "space-y-3 rounded-large-element bg-primary text-secondary p-4";

/**
 * @param {{
 *   open: boolean,
 *   value: GalleryFilters,
 *   onClose: () => void,
 *   onApply: (filters: GalleryFilters) => void,
 *   onOpenDates?: () => void,
 *   places?: object[],
 *   focusSection?: ""|"when"|"where"|"camera"|"look"|string,
 * }} props
 */
export default function GalleryFilterSheet({
  open,
  value,
  onClose,
  onApply,
  onOpenDates,
  places = [],
  focusSection = "",
}) {
  const [draft, setDraft] = useState(() => ({ ...EMPTY_FILTERS, ...value }));
  const [cameras, setCameras] = useState(/** @type {Array<{make:string,model:string,count:number}>} */ ([]));
  const [facets, setFacets] = useState(/** @type {object|null} */ (null));
  const [saved, setSaved] = useState(readSavedFilters);
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft({
      ...EMPTY_FILTERS,
      ...value,
      formats: [...(value?.formats || [])],
      placeBbox: value?.placeBbox ? [...value.placeBbox] : null,
      undated: !!value?.undated,
      albumMembership: value?.albumMembership || "",
    });
    setSaved(readSavedFilters());
  }, [open, value]);

  useEffect(() => {
    if (!open || !focusSection) return undefined;
    const id = `filter-${focusSection}`;
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => clearTimeout(t);
  }, [open, focusSection]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await getJson("/api/v1/gallery/cameras");
        if (!cancelled) setCameras(Array.isArray(data?.cameras) ? data.cameras : []);
      } catch {
        if (!cancelled) setCameras([]);
      }
      try {
        const data = await getJson("/api/v1/gallery/filter-facets");
        if (!cancelled) setFacets(data && typeof data === "object" ? data : null);
      } catch {
        if (!cancelled) setFacets(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const cameraOptions = useMemo(() => {
    const opts = [{ value: "", label: "Any camera" }];
    for (const cam of cameras) {
      const make = cam.make || "";
      const model = cam.model || "";
      const valueKey = `${make}\0${model}`;
      const label = [make, model].filter(Boolean).join(" ") || "Unknown";
      opts.push({
        value: valueKey,
        label: cam.count ? `${label} (${cam.count})` : label,
      });
    }
    return opts;
  }, [cameras]);

  const cameraValue =
    draft.cameraMake || draft.cameraModel
      ? `${draft.cameraMake || ""}\0${draft.cameraModel || ""}`
      : "";

  const lensOptions = useMemo(() => {
    const list = facets?.lenses || facets?.lens || [];
    if (!Array.isArray(list) || !list.length) return null;
    return [
      { value: "", label: "Any lens" },
      ...list.map((l) => {
        const name = typeof l === "string" ? l : l.name || l.label || "";
        return { value: name, label: name };
      }),
    ];
  }, [facets]);

  const formatOptions = useMemo(() => {
    const list = facets?.formats || facets?.extensions || [];
    if (Array.isArray(list) && list.length) {
      return list.map((f) => (typeof f === "string" ? f : f.name || f.ext || "")).filter(Boolean);
    }
    return ["jpg", "heic", "png", "mp4", "mov"];
  }, [facets]);

  const showLensExposure = !!(lensOptions || facets?.iso || facets?.focal || facets?.flash);

  function patch(partial) {
    setDraft((prev) => ({ ...prev, ...partial }));
  }

  function applyTimePreset(key) {
    if (!key) {
      patch({ timePreset: "", hourFrom: "", hourTo: "" });
      return;
    }
    const preset = TIME_PRESETS[key];
    if (!preset) return;
    patch({ timePreset: key, hourFrom: preset.from, hourTo: preset.to });
  }

  function clearAll() {
    setDraft({ ...EMPTY_FILTERS, formats: [] });
  }

  function saveCurrent() {
    const name = saveName.trim();
    if (!name) return;
    const next = [
      { id: `${Date.now()}`, name, filters: { ...draft, formats: [...(draft.formats || [])] } },
      ...saved.filter((s) => s.name !== name),
    ].slice(0, 20);
    writeSavedFilters(next);
    setSaved(next);
    setSaveName("");
  }

  function toggleFormat(fmt) {
    const cur = new Set(draft.formats || []);
    if (cur.has(fmt)) cur.delete(fmt);
    else cur.add(fmt);
    patch({ formats: [...cur] });
  }

  return (
    <ModalCard
      open={open}
      title="Filters"
      size="lg"
      onClose={onClose}
      footer={({ close }) => (
        <div className="flex flex-wrap gap-2 justify-end">
          <Button type="button" variant="outline" onClick={clearAll}>
            Clear all
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={() => {
              onApply(draft);
              close();
            }}
          >
            Apply
          </Button>
        </div>
      )}
    >
      <div className="space-y-4" data-slot="gallery-filter-sheet">
        <section className={sectionClass} aria-labelledby="filter-when" id="filter-when">
          <h3 className="font-mono text-sm">
            When
          </h3>
          <p className="text-sm">Show photos taken between these dates.</p>
          <div className="flex flex-wrap gap-2">
            {[
              { id: "last7", label: "Last 7 days" },
              { id: "thisMonth", label: "This month" },
              { id: "thisYear", label: "This year" },
            ].map((preset) => (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant="outline"
                surface="primary"
                onClick={() => {
                  const range = datePresetRange(preset.id);
                  patch({ dateFrom: range.from, dateTo: range.to, undated: false });
                }}
              >
                {preset.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={draft.undated ? "accent" : "outline"}
              surface="primary"
              onClick={() =>
                patch({
                  undated: !draft.undated,
                  dateFrom: "",
                  dateTo: "",
                })
              }
            >
              Undated
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-sm flex-1 min-w-[8rem]">
              From
              <input
                type="date"
                value={draft.dateFrom || ""}
                disabled={!!draft.undated}
                onChange={(e) => patch({ dateFrom: e.target.value, undated: false })}
                className={`mt-1 ${inputClass}`}
                aria-label="From date"
              />
            </label>
            <label className="block text-sm flex-1 min-w-[8rem]">
              To
              <input
                type="date"
                value={draft.dateTo || ""}
                disabled={!!draft.undated}
                onChange={(e) => patch({ dateTo: e.target.value, undated: false })}
                className={`mt-1 ${inputClass}`}
                aria-label="To date"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              surface="primary"
              onClick={() => patch({ dateFrom: "", dateTo: "", undated: false })}
            >
              Clear dates
            </Button>
            {onOpenDates && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                surface="primary"
                onClick={() => {
                  onOpenDates();
                  onClose();
                }}
              >
                Jump on timeline…
              </Button>
            )}
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="filter-where" id="filter-where">
          <h3 id="filter-where-heading" className="font-mono text-sm flex items-center gap-2">
            Where
            <InfoHint
              label="Location filter help"
              surface="primary"
              content={
                <>
                  Draws a box on the map using{" "}
                  <TermHint content="Location tags some phones and cameras store with a photo.">
                    GPS
                  </TermHint>
                  . Only photos tagged inside the box are shown.
                </>
              }
            />
          </h3>
          <GeozoneMap
            places={places}
            value={draft.placeBbox || null}
            onChange={(bbox) => patch({ placeBbox: bbox })}
          />
        </section>

        <section className={sectionClass} aria-labelledby="filter-camera">
          <h3 id="filter-camera" className="font-mono text-sm flex items-center gap-2">
            Camera
            <InfoHint
              label="Camera filter help"
              surface="primary"
              content={
                <>
                  Uses{" "}
                  <TermHint content="Details the camera wrote into the photo file, like make and model.">
                    EXIF
                  </TermHint>{" "}
                  when Luna has indexed it.
                </>
              }
            />
          </h3>
          <Dropdown
            options={cameraOptions}
            value={cameraValue}
            onChange={(v) => {
              if (!v) {
                patch({ cameraMake: "", cameraModel: "" });
                return;
              }
              const [make, model] = v.split("\0");
              patch({ cameraMake: make || "", cameraModel: model || "" });
            }}
            bg="secondary"
            fullWidth
            aria-label="Camera"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            surface="primary"
            onClick={() => patch({ cameraMake: "", cameraModel: "" })}
          >
            Clear
          </Button>
        </section>

        {showLensExposure && (
          <section className={sectionClass} aria-labelledby="filter-lens">
            <h3 id="filter-lens" className="font-mono text-sm">
              Lens / exposure
            </h3>
            {lensOptions && (
              <Dropdown
                options={lensOptions}
                value={draft.lens || ""}
                onChange={(v) => patch({ lens: v })}
                bg="secondary"
                fullWidth
                aria-label="Lens"
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                ISO min
                <input
                  type="number"
                  min="0"
                  value={draft.isoMin || ""}
                  onChange={(e) => patch({ isoMin: e.target.value })}
                  className={`mt-1 ${inputClass}`}
                />
              </label>
              <label className="block text-sm">
                ISO max
                <input
                  type="number"
                  min="0"
                  value={draft.isoMax || ""}
                  onChange={(e) => patch({ isoMax: e.target.value })}
                  className={`mt-1 ${inputClass}`}
                />
              </label>
              <label className="block text-sm">
                Focal min (mm)
                <input
                  type="number"
                  min="0"
                  value={draft.focalMin || ""}
                  onChange={(e) => patch({ focalMin: e.target.value })}
                  className={`mt-1 ${inputClass}`}
                />
              </label>
              <label className="block text-sm">
                Focal max (mm)
                <input
                  type="number"
                  min="0"
                  value={draft.focalMax || ""}
                  onChange={(e) => patch({ focalMax: e.target.value })}
                  className={`mt-1 ${inputClass}`}
                />
              </label>
            </div>
            <Dropdown
              options={[
                { value: "", label: "Flash: any" },
                { value: "on", label: "Flash on" },
                { value: "off", label: "Flash off" },
              ]}
              value={draft.flash || ""}
              onChange={(v) => patch({ flash: v })}
              bg="secondary"
              fullWidth
              aria-label="Flash"
            />
          </section>
        )}

        <section className={sectionClass} aria-labelledby="filter-look" id="filter-look">
          <h3 id="filter-look-heading" className="font-mono text-sm">
            Look
          </h3>
          <div className="space-y-2">
            <p className="text-sm">Type</p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "", label: "All" },
                { value: "image", label: "Photos" },
                { value: "video", label: "Videos" },
              ].map((opt) => (
                <Button
                  key={opt.value || "all"}
                  type="button"
                  size="sm"
                  variant={(draft.kind || "") === opt.value ? "accent" : "outline"}
                  surface="primary"
                  onClick={() => patch({ kind: opt.value })}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm flex items-center gap-1">
              Album membership
              <InfoHint
                label="Album membership help"
                surface="primary"
                content="Checks albums stored on the same drive as each photo. Albums whose home is on another drive are not counted."
              />
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "", label: "Any" },
                { value: "any", label: "In an album" },
                { value: "none", label: "Not in an album" },
              ].map((opt) => (
                <Button
                  key={opt.value || "album-any"}
                  type="button"
                  size="sm"
                  variant={(draft.albumMembership || "") === opt.value ? "accent" : "outline"}
                  surface="primary"
                  onClick={() => patch({ albumMembership: opt.value })}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm">Orientation</p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "", label: "Any" },
                { value: "landscape", label: "Landscape" },
                { value: "portrait", label: "Portrait" },
                { value: "square", label: "Square" },
              ].map((opt) => (
                <Button
                  key={opt.value || "any-orient"}
                  type="button"
                  size="sm"
                  variant={(draft.orientation || "") === opt.value ? "accent" : "outline"}
                  surface="primary"
                  onClick={() => patch({ orientation: opt.value })}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm">Format</p>
            <div className="flex flex-wrap gap-2">
              {formatOptions.map((fmt) => {
                const active = (draft.formats || []).includes(fmt);
                return (
                  <Button
                    key={fmt}
                    type="button"
                    size="sm"
                    variant={active ? "accent" : "outline"}
                    surface="primary"
                    onClick={() => toggleFormat(fmt)}
                  >
                    {String(fmt).toUpperCase()}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm flex items-center gap-1">
              Has{" "}
              <TermHint content="A location tag some phones and cameras store with a photo.">
                GPS
              </TermHint>{" "}
              location
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "", label: "Any" },
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ].map((opt) => (
                <Button
                  key={opt.value || "gps-any"}
                  type="button"
                  size="sm"
                  variant={(draft.hasGps || "") === opt.value ? "accent" : "outline"}
                  surface="primary"
                  onClick={() => patch({ hasGps: opt.value })}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <label className="block text-sm">
            Min megapixels
            <input
              type="number"
              min="0"
              step="0.1"
              value={draft.minMegapixels || ""}
              onChange={(e) => patch({ minMegapixels: e.target.value })}
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Video length min (s)
              <input
                type="number"
                min="0"
                value={draft.minDuration || ""}
                onChange={(e) => patch({ minDuration: e.target.value })}
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="block text-sm">
              Video length max (s)
              <input
                type="number"
                min="0"
                value={draft.maxDuration || ""}
                onChange={(e) => patch({ maxDuration: e.target.value })}
                className={`mt-1 ${inputClass}`}
              />
            </label>
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="filter-tod">
          <h3 id="filter-tod" className="font-mono text-sm">
            Time of day
          </h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(TIME_PRESETS).map(([key, preset]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={draft.timePreset === key ? "accent" : "outline"}
                surface="primary"
                onClick={() => applyTimePreset(draft.timePreset === key ? "" : key)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Hour from
              <input
                type="number"
                min="0"
                max="23"
                value={draft.hourFrom || ""}
                onChange={(e) => patch({ timePreset: "", hourFrom: e.target.value })}
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="block text-sm">
              Hour to
              <input
                type="number"
                min="0"
                max="24"
                value={draft.hourTo || ""}
                onChange={(e) => patch({ timePreset: "", hourTo: e.target.value })}
                className={`mt-1 ${inputClass}`}
              />
            </label>
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="filter-saved">
          <h3 id="filter-saved" className="font-mono text-sm">
            Saved filters
          </h3>
          <p className="text-sm">Save this set to reuse later on this browser.</p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. Phone only"
              aria-label="Saved filter name"
              className={`flex-1 min-w-[10rem] ${inputClass}`}
            />
            <Button type="button" size="sm" variant="secondary" surface="primary" onClick={saveCurrent}>
              Save
            </Button>
          </div>
          {saved.length > 0 && (
            <ul className="space-y-2">
              {saved.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-pill bg-secondary text-primary px-3 py-2"
                >
                  <span className="font-mono text-sm truncate">{item.name}</span>
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="accent"
                      onClick={() =>
                        setDraft({
                          ...EMPTY_FILTERS,
                          ...item.filters,
                          formats: [...(item.filters?.formats || [])],
                        })
                      }
                    >
                      Apply
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const next = saved.filter((s) => s.id !== item.id);
                        writeSavedFilters(next);
                        setSaved(next);
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ModalCard>
  );
}

GalleryFilterSheet.propTypes = {
  open: PropTypes.bool.isRequired,
  value: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
  onApply: PropTypes.func.isRequired,
  onOpenDates: PropTypes.func,
  places: PropTypes.arrayOf(PropTypes.object),
  focusSection: PropTypes.string,
};
