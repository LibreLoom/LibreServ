import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

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
 * @param {{ photo: object, src: string, autoPlay?: boolean }} props
 */
export default function LightboxMedia({ photo, src, autoPlay = true }) {
  // "loading" (thumbnail only) → "primed" (media at thumbnail scale) → "grown".
  const [phase, setPhase] = useState("loading");
  const [reduced] = useState(() => prefersReducedMotion());
  const scaleFrom = useRef(1);
  const thumbRef = useRef(/** @type {HTMLImageElement|null} */ (null));
  const mediaRef = useRef(/** @type {HTMLElement|null} */ (null));

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
          className={`${THUMB_STAGE_CAP} rounded-large-element object-contain`}
          style={{
            opacity: phase === "grown" ? 0 : 1,
            transition: reduced
              ? "none"
              : "opacity var(--motion-duration-medium1) var(--motion-easing-standard) var(--motion-duration-short3)",
          }}
        />
      ) : null}
      {photo.kind === "video" ? (
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
        >
          Your browser cannot play this video. Download it instead.
        </video>
      ) : (
        <img
          key={src}
          ref={(el) => {
            mediaRef.current = el;
            if (el && el.complete && el.naturalWidth > 0) handleReady();
          }}
          src={src}
          alt={photo.name}
          className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
          style={mediaStyle}
          onLoad={handleReady}
          onError={(e) => {
            // HEIC preview may 404 until backend lands — fall back to thumb.
            if (photo.thumb && e.currentTarget.src !== photo.thumb) {
              e.currentTarget.src = photo.thumb;
            } else {
              setPhase("grown");
            }
          }}
        />
      )}
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
  autoPlay: PropTypes.bool,
};

LightboxMedia.defaultProps = {
  autoPlay: true,
};
