import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import {
  Aperture,
  CalendarDays,
  Camera,
  Clock,
  FileImage,
  Film,
  Flashlight,
  FolderOpen,
  Heart,
  MapPin,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, CircleMarker } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";
import { fmtSize, folderHref } from "../../lib/paths.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** Same layer as other dialogs stacked over PhotoLightbox (its z-[80]). */
const PANEL_Z_CLASS = "z-[90]";

function useIsDesktop() {
  const read = () =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(min-width: 768px)").matches;
  const [desktop, setDesktop] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/** @param {number} [secs] */
function fmtDuration(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** @param {{ icon: import("react").ComponentType<any>, title: string, children: import("react").ReactNode }} props */
function Section({ icon: Icon, title, children }) {
  return (
    <section className="rounded-large-element bg-primary text-secondary p-3.5 space-y-2.5">
      <h3 className="flex items-center gap-2 font-mono text-xs text-accent">
        <Icon size={14} className="shrink-0" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

Section.propTypes = {
  icon: PropTypes.elementType.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};

/** @param {{ children: import("react").ReactNode }} props */
function SpecChip({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-secondary text-primary px-2.5 py-1 text-xs font-mono">
      {children}
    </span>
  );
}

SpecChip.propTypes = { children: PropTypes.node.isRequired };

/** Mini map showing where the photo was taken, with other located photos dimmed. */
function PhotoLocationMap({ lat, lon, photos = [], onSelectPhoto }) {
  const others = photos.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      !(p.lat === lat && p.lon === lon),
  );
  return (
    <div className="overflow-hidden rounded-large-element border-2 border-secondary/30 h-40">
      <MapContainer
        center={[lat, lon]}
        zoom={13}
        className="h-full w-full"
        scrollWheelZoom
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        {others.slice(0, 300).map((p) => (
          <CircleMarker
            key={p.path || `${p.lat},${p.lon}`}
            center={[p.lat, p.lon]}
            radius={4}
            eventHandlers={
              onSelectPhoto
                ? {
                    click: () => {
                      haptic("selection");
                      onSelectPhoto(p);
                    },
                  }
                : undefined
            }
            pathOptions={{
              color: "var(--color-secondary)",
              fillColor: "var(--color-secondary)",
              fillOpacity: 0.45,
              weight: 1,
            }}
          />
        ))}
        <CircleMarker
          center={[lat, lon]}
          radius={8}
          pathOptions={{
            color: "var(--color-secondary)",
            fillColor: "var(--color-accent)",
            fillOpacity: 0.9,
            weight: 2,
          }}
        />
      </MapContainer>
    </div>
  );
}

PhotoLocationMap.propTypes = {
  lat: PropTypes.number.isRequired,
  lon: PropTypes.number.isRequired,
  photos: PropTypes.arrayOf(PropTypes.object),
  onSelectPhoto: PropTypes.func,
};

function PhotoInfoBody({ photo, photos, onSelectPhoto }) {
  const hasCoords = Number.isFinite(photo.lat) && Number.isFinite(photo.lon);
  const folder = (photo.path || "").split("/").slice(0, -1).join("/");
  const camera = [photo.camera_make, photo.camera_model].filter(Boolean).join(" ");
  const duration = fmtDuration(photo.duration_secs);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-large-element bg-primary border-2 border-secondary/30">
          {photo.thumb ? (
            <img src={photo.thumb} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-accent">
              {photo.kind === "video" ? <Film size={20} /> : <FileImage size={20} />}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm">{photo.name}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <SpecChip>{photo.kind === "video" ? "Video" : "Photo"}</SpecChip>
            {photo.favorited && (
              <SpecChip>
                <Heart size={11} fill="currentColor" aria-hidden="true" />
                Favorite
              </SpecChip>
            )}
          </div>
        </div>
      </div>

      <Section icon={CalendarDays} title="Taken">
        <p className="text-sm">
          {photo.taken_at
            ? new Date(photo.taken_at * 1000).toLocaleString()
            : "Date unknown"}
        </p>
      </Section>

      {hasCoords && (
        <Section icon={MapPin} title="Where">
          <PhotoLocationMap
            lat={photo.lat}
            lon={photo.lon}
            photos={photos}
            onSelectPhoto={onSelectPhoto}
          />
        </Section>
      )}

      {(camera || photo.lens || photo.iso > 0 || photo.focal_mm > 0 || photo.flash >= 0) && (
        <Section icon={Camera} title="Camera">
          {camera && <p className="text-sm font-mono">{camera}</p>}
          <div className="flex flex-wrap gap-1.5">
            {photo.lens && <SpecChip>{photo.lens}</SpecChip>}
            {photo.iso > 0 && <SpecChip>ISO {photo.iso}</SpecChip>}
            {photo.focal_mm > 0 && (
              <SpecChip>
                <Aperture size={11} aria-hidden="true" />
                {photo.focal_mm} mm
              </SpecChip>
            )}
            {photo.flash === 1 && (
              <SpecChip>
                <Flashlight size={11} aria-hidden="true" />
                Flash on
              </SpecChip>
            )}
            {photo.flash === 0 && (
              <SpecChip>
                <Flashlight size={11} aria-hidden="true" />
                Flash off
              </SpecChip>
            )}
          </div>
        </Section>
      )}

      <Section icon={FileImage} title="File">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          {photo.size != null && (
            <>
              <dt className="text-accent">Size</dt>
              <dd className="font-mono">{fmtSize(photo.size)}</dd>
            </>
          )}
          {(photo.width > 0 || photo.height > 0) && (
            <>
              <dt className="text-accent">Dimensions</dt>
              <dd className="font-mono">
                {photo.width} × {photo.height}
              </dd>
            </>
          )}
          {duration && (
            <>
              <dt className="flex items-center gap-1 text-accent">
                <Clock size={12} aria-hidden="true" />
                Length
              </dt>
              <dd className="font-mono">{duration}</dd>
            </>
          )}
          {photo.drive_id && (
            <>
              <dt className="flex items-center gap-1 text-accent">
                <FolderOpen size={12} aria-hidden="true" />
                Folder
              </dt>
              <dd className="min-w-0">
                <Link
                  to={folderHref(photo.drive_id, folder)}
                  className="block truncate font-mono underline decoration-dotted underline-offset-4 hover:text-accent"
                  onClick={() => haptic("selection")}
                >
                  {folder || "/"}
                </Link>
              </dd>
            </>
          )}
        </dl>
      </Section>
    </div>
  );
}

PhotoInfoBody.propTypes = {
  photo: PropTypes.object.isRequired,
  photos: PropTypes.arrayOf(PropTypes.object),
  onSelectPhoto: PropTypes.func,
};

/**
 * Photo metadata viewer: left slide-in panel on desktop, modal on mobile.
 * Structured sections — preview, taken, where (map), camera, file.
 *
 * @param {{
 *   photo: object,
 *   open: boolean,
 *   onClose: () => void,
 *   photos?: object[],
 *   onSelectPhoto?: (photo: object) => void,
 * }} props
 */
export default function PhotoInfoPanel({ photo, open, onClose, photos, onSelectPhoto }) {
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <ModalCard
        open={open}
        onClose={onClose}
        title="About this photo"
        size="md"
        overlayClassName={PANEL_Z_CLASS}
      >
        <PhotoInfoBody photo={photo} photos={photos} onSelectPhoto={onSelectPhoto} />
      </ModalCard>
    );
  }

  if (!photo) return null;

  return (
    <aside
      data-slot="photo-info-panel"
      aria-label="Photo details"
      aria-hidden={!open}
      className={cn(
        "shrink-0 overflow-hidden",
        "motion-safe:transition-[width,visibility] motion-safe:duration-200 motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
        open ? "w-[22.5rem]" : "w-0 invisible pointer-events-none",
      )}
    >
      <div
        className={cn(
          "h-full w-[22.5rem] py-3 pr-3 origin-right will-change-transform",
          "motion-safe:transition-[transform,opacity] motion-safe:duration-200 motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
          open ? "translate-x-0 scale-100 opacity-100" : "translate-x-3 scale-[0.98] opacity-0",
        )}
      >
        <div className="h-full overflow-y-auto rounded-large-element bg-secondary text-primary p-3.5 ring-2 ring-accent shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-mono text-sm">About this photo</h2>
          <Button
            variant="ghost"
            size="iconSm"
            className="shrink-0 rounded-full"
            aria-label="Close details"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              haptic("light");
              onClose();
            }}
          >
            <X size={16} />
          </Button>
        </div>
        <PhotoInfoBody photo={photo} photos={photos} onSelectPhoto={onSelectPhoto} />
        </div>
      </div>
    </aside>
  );
}

PhotoInfoPanel.propTypes = {
  photo: PropTypes.object,
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  photos: PropTypes.arrayOf(PropTypes.object),
  onSelectPhoto: PropTypes.func,
};
