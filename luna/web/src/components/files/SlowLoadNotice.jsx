import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { fileExtension, OFFICE_FORMATS } from "../../lib/fileKinds.js";

/** How long the loader runs before the card appears. */
export const SLOW_LOAD_MS = 8000;

const OFFICE_NOUN = {
  word: "document",
  cell: "spreadsheet",
  slide: "presentation",
};

/** @param {string} name */
function documentNoun(name) {
  return OFFICE_NOUN[OFFICE_FORMATS[fileExtension(name)]] || "file";
}

/**
 * Card shown over the loading dots once an editor has been opening for a
 * while. The editor's code is downloaded once per browser, so on a slow
 * connection the first open can look stuck. Mount it only while loading:
 * unmounting resets the timer.
 *
 * @param {{ name: string, delayMs?: number }} props
 */
export default function SlowLoadNotice({ name, delayMs = SLOW_LOAD_MS }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center p-4">
      <div
        role="status"
        className="max-w-md rounded-large-element surface-secondary p-4 text-sm"
      >
        <p className="font-mono text-base">Still opening</p>
        <p className="mt-1">
          If you're opening a {documentNoun(name)} for the first time on this
          browser, it can take a while.
        </p>
      </div>
    </div>
  );
}

SlowLoadNotice.propTypes = {
  name: PropTypes.string.isRequired,
  delayMs: PropTypes.number,
};
