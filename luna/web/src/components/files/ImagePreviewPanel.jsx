import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import Spinner from "../ui/Spinner.jsx";

/** Minimum preview height while a photo is loading (px). */
const LOADING_MIN_HEIGHT = 192;

/**
 * Photo preview with loading spinner, smooth height growth, and expand sizing.
 *
 * @param {{
 *   src: string,
 *   alt: string,
 *   expanded?: boolean,
 * }} props
 */
export default function ImagePreviewPanel({ src, alt, expanded = false }) {
  const [status, setStatus] = useState(/** @type {"loading"|"loaded"|"error"} */ ("loading"));

  useEffect(() => {
    let cancelled = false;

    const img = new Image();
    img.onload = () => {
      if (!cancelled) setStatus("loaded");
    };
    img.onerror = () => {
      if (!cancelled) setStatus("error");
    };
    img.src = src;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);

  const containerMaxHeight = expanded ? "max-h-[90vh]" : "max-h-[70vh]";
  const imageMaxHeight = expanded ? "max-h-[85vh]" : "max-h-[65vh]";

  return (
    <div
      className={cn(
        "rounded-large-element bg-primary text-secondary p-2 flex items-center justify-center overflow-auto",
        containerMaxHeight,
      )}
      style={{ minHeight: status === "loading" ? LOADING_MIN_HEIGHT : undefined }}
      aria-busy={status === "loading" || undefined}
    >
      {status === "loading" && (
        <div className="flex flex-col items-center justify-center gap-3 py-10">
          <Spinner label="Loading" className="text-secondary" />
          <p className="text-sm text-secondary">Loading...</p>
        </div>
      )}

      {status === "error" && (
        <p className="text-sm text-secondary px-4 py-10 text-center">
          Could not load this photo. Try downloading it instead.
        </p>
      )}

      {status === "loaded" && (
        <img
          src={src}
          alt={alt}
          className={cn(
            "max-w-full object-contain motion-safe:animate-page-enter",
            imageMaxHeight,
          )}
        />
      )}
    </div>
  );
}

ImagePreviewPanel.propTypes = {
  src: PropTypes.string.isRequired,
  alt: PropTypes.string.isRequired,
  expanded: PropTypes.bool,
};
