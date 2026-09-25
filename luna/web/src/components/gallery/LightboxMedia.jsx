import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Download, ImageOff, VideoOff } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { isHeicFile } from "../../lib/fileKinds.js";

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fallback grow origin when there is no thumbnail to measure against. */
const EMPTY_STAGE_SCALE = 0.9;
/** Thumbnail layer cap so the grow always has room to read. */
const THUMB_STAGE_CAP = "max-h-[45%] max-w-[45%]";

/**
 * Photo/video stage for PhotoLightbox. While the full media downloads, the
 * grid thumbnail shows at a small size; once the media is decoded it grows
 * from the thumbnail's footprint to the fitted full-size view, so the wait
 * reads as one continuous motion instead of a pop-in.
 *
 * `lite` panes (carousel panes being swept past) render the thumbnail only,
 * so rapid navigation never downloads full media for every photo passed.
 *
 * Media the browser can't decode — a video codec it doesn't support, or a
 * corrupt file — swaps to a notice with a download link instead of hanging
 * forever on the thumbnail. HEIC stills whose transcoded preview isn't
 * ready are the one exception: they fall back to the drive thumbnail and
 * say so, since a stretched thumb beats a dead pane but is still a preview.
 *
 * @param {{ photo: object, src: string, downloadSrc?: string, autoPlay?: boolean, lite?: boolean }} props
 */
export default function LightboxMedia({ photo, src, downloadSrc = "", autoPlay = true, lite = false }) {
  // "loading" (thumbnail only) → "primed" (media at thumbnail scale) → "grown".
  const [phase, setPhase] = useState("loading");
  const [failed, setFailed] = useState(false);
  const [thumbFallback, setThumbFallback] = useState(false);
  const [reduced] = useState(() => prefersReducedMotion());
  const scaleFrom = useRef(1);
  const thumbRef = useRef(/** @type {HTMLImageElement|null} */ (null));
  const mediaRef = useRef(/** @type {HTMLElement|null} */ (null));

  // A new src means new media to decode — replay the reveal and clear any
  // stale failure left by the previous source.
  const [seenSrc, setSeenSrc] = useState(src);
  if (seenSrc !== src) {
    setSeenSrc(src);
    setPhase("loading");
    setFailed(false);
    setThumbFallback(false);
  }

  // Off-center carousel panes mount with autoPlay=false — pause a video that
  // kept playing after sliding away from center.
  useEffect(() => {
    const el = /** @type {HTMLMediaElement|null} */ (mediaRef.current);
    if (!autoPlay && typeof el?.pause === "function") {
      el.pause();
    }
  }, [autoPlay]);

  useEffect(() => {
    if (phase !== "primed") return undefined;
    // Let the primed frame paint before releasing the grow transition.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase("grown"));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [phase]);

  function handleReady() {
    if (phase !== "loading") return;
    if (reduced) {
      setPhase("grown");
      return;
    }
    const t = thumbRef.current?.getBoundingClientRect();
    const m = mediaRef.current?.getBoundingClientRect();
    scaleFrom.current =
      t?.width && t?.height && m?.width && m?.height
        ? Math.min(1, Math.max(t.width / m.width, t.height / m.height))
        : EMPTY_STAGE_SCALE;
    setPhase("primed");
  }

  const isVideo = photo.kind === "video";
  // The thumb swap exists for HEIC previews that 404 until the backend
  // preview lands. For anything else a failed load is a real failure — a
  // stretched thumbnail standing in for the photo reads as a broken render
  // with no explanation. Already showing the thumb src (or out of retries)
  // counts as a failure too.
  const canThumbFallback =
    !isVideo && !thumbFallback && isHeicFile(photo.name)
    && photo.thumb && photo.thumb !== src;
  const mediaStyle =
    phase === "primed"
      ? {
          opacity: 1,
          transform: `scale(${scaleFrom.current})`,
          transition:
            "opacity var(--motion-duration-short4) var(--motion-easing-standard)",
          willChange: "transform, opacity",
        }
      : {
          opacity: phase === "loading" ? 0 : 1,
          transition: reduced
            ? "none"
            : "transform var(--motion-duration-long1) var(--motion-easing-emphasized-decelerate), opacity var(--motion-duration-short4) var(--motion-easing-standard)",
          willChange: "transform, opacity",
        };

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {photo.thumb ? (
        <img
          ref={thumbRef}
          src={photo.thumb}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`${THUMB_STAGE_CAP} rounded-large-element object-contain`}
          style={{
            opacity: phase === "grown" || failed ? 0 : 1,
            transition: reduced
              ? "none"
              : "opacity var(--motion-duration-medium1) var(--motion-easing-standard) var(--motion-duration-short3)",
          }}
        />
      ) : null}
      {lite ? null : failed ? (
        <div
          role="alert"
          data-slot="lightbox-media-error"
          className="absolute inset-0 m-auto flex h-fit w-fit max-w-[min(22rem,85%)] flex-col items-center gap-3 rounded-large-element bg-secondary px-8 py-6 text-center text-primary motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
        >
          {isVideo ? (
            <VideoOff size={28} aria-hidden="true" />
          ) : (
            <ImageOff size={28} aria-hidden="true" />
          )}
          <p className="text-sm">
            {isVideo
              ? "This video can't play in the browser. Download it to watch on your device."
              : "This photo can't be displayed in the browser. Download it to try opening it on your device."}
          </p>
          {downloadSrc ? (
            <Button variant="primary" size="sm" asChild>
              <a href={downloadSrc} download>
                <Download size={16} />
                Download
              </a>
            </Button>
          ) : null}
        </div>
      ) : isVideo ? (
        <video
          key={src}
          ref={(el) => {
            mediaRef.current = el;
            if (el && el.readyState >= 2) handleReady();
          }}
          controls
          autoPlay={autoPlay}
          className="absolute inset-0 m-auto max-h-full max-w-full rounded-large-element"
          style={mediaStyle}
          src={src}
          onLoadedData={handleReady}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          key={src}
          ref={(el) => {
            mediaRef.current = el;
            if (el && el.complete && el.naturalWidth > 0) handleReady();
          }}
          src={src}
          alt={photo.name}
          draggable={false}
          className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
          style={mediaStyle}
          onLoad={handleReady}
          onError={(e) => {
            if (canThumbFallback) {
              setThumbFallback(true);
              e.currentTarget.src = photo.thumb;
            } else {
              setFailed(true);
            }
          }}
        />
      )}
      {thumbFallback && !failed ? (
        <p className="absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[85%] rounded-pill bg-secondary px-4 py-2 text-center text-xs text-primary motion-safe:animate-in motion-safe:fade-in">
          The full-size photo couldn't load — this is a small preview.
        </p>
      ) : null}
    </div>
  );
}

LightboxMedia.propTypes = {
  photo: PropTypes.shape({
    name: PropTypes.string,
    kind: PropTypes.string,
    thumb: PropTypes.string,
  }).isRequired,
  src: PropTypes.string.isRequired,
  downloadSrc: PropTypes.string,
  autoPlay: PropTypes.bool,
  lite: PropTypes.bool,
};

LightboxMedia.defaultProps = {
  downloadSrc: "",
  autoPlay: true,
  lite: false,
};
