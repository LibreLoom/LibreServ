import PropTypes from "prop-types";
import { Heart, Play } from "lucide-react";

/** Dense edge-to-edge photo cell for the timeline grid. */
export default function PhotoThumb({ photo, onClick, selected }) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(photo)}
      className={`group relative block w-full aspect-square overflow-hidden bg-secondary text-primary motion-safe:transition-opacity hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        selected ? "ring-2 ring-accent" : ""
      }`}
      aria-label={photo.name}
    >
      {photo.thumb ? (
        <img
          src={photo.thumb}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-xs">
          {photo.kind === "video" ? "Video" : "Photo"}
        </span>
      )}
      {photo.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-pill bg-primary text-secondary">
          <Play size={14} fill="currentColor" aria-hidden="true" />
        </span>
      )}
      {photo.favorited && (
        <span
          className="absolute top-2 right-2 [filter:drop-shadow(0_0_1.5px_var(--secondary))]"
          aria-hidden="true"
        >
          <Heart
            size={14}
            className="fill-primary stroke-secondary"
            strokeWidth={2.25}
            aria-hidden="true"
          />
        </span>
      )}
    </button>
  );
}

PhotoThumb.propTypes = {
  photo: PropTypes.shape({
    name: PropTypes.string,
    thumb: PropTypes.string,
    kind: PropTypes.string,
    favorited: PropTypes.bool,
  }).isRequired,
  onClick: PropTypes.func,
  selected: PropTypes.bool,
};

PhotoThumb.defaultProps = {
  selected: false,
};
