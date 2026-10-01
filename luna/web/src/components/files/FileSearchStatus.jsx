import { useEffect, useState } from "react";
import Typewriter from "@libreloom/ui/components/ui/Typewriter.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";

/** A scan that ends this fast never needs a notice. */
const SHOW_AFTER_MS = 700;
/** How long "Finished" stays up before the pill goes away. */
const DONE_FOR_MS = 2600;

/**
 * @param {import("../../lib/fileSearch.js").ScanStatus | null} scan
 * @returns {string}
 */
function readingText(scan) {
  if (!scan) return "Still reading your drives";
  const progress = scan.drives_total > 1 ? ` · ${scan.drives_done} of ${scan.drives_total} done` : "";
  const folders = scan.dirs_indexed ? ` · ${scan.dirs_indexed.toLocaleString()} folders` : "";
  return `Still reading your drives${progress}${folders}`;
}

/**
 * A small pill that says Luna is still reading drives, so a missing file
 * might just not have been found yet. It waits a moment before appearing
 * (quick scans stay silent), types its text, and says when it's finished.
 *
 * @param {{ scan: import("../../lib/fileSearch.js").ScanStatus | null, className?: string }} props
 */
export default function FileSearchStatus({ scan, className }) {
  const scanning = Boolean(scan?.scanning);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (scanning && !shown) {
      const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (!scanning && shown) {
      const t = setTimeout(() => setShown(false), DONE_FOR_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [scanning, shown]);

  const failed = scan?.drives_failed ?? 0;
  if (!shown && failed > 0 && !scanning) {
    // Stays up: files on that drive can't turn up until it's readable again.
    return (
      <p
        role="status"
        data-slot="file-search-status"
        className={cn("inline-flex items-center gap-2 rounded-pill surface-primary px-3 py-1 text-xs font-mono", className)}
      >
        <span aria-hidden="true" className="size-2 shrink-0 rounded-pill border-2 border-accent" />
        {failed === 1
          ? "Luna couldn't read 1 drive, so some files may not show up."
          : `Luna couldn't read ${failed} drives, so some files may not show up.`}
      </p>
    );
  }
  if (!shown) return null;
  const reading = scanning;
  return (
    <p
      role="status"
      data-slot="file-search-status"
      className={cn(
        "inline-flex items-center gap-2 rounded-pill surface-primary px-3 py-1 text-xs font-mono",
        "file-search-row-enter",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-pill border-2 border-accent",
          reading ? "motion-safe:animate-pulse" : "surface-secondary",
        )}
      />
      <Typewriter text={reading ? readingText(scan) : "Finished reading your drives"} cursor={false} />
    </p>
  );
}
