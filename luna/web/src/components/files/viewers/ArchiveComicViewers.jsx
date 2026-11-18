import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { fileExtension } from "../../../lib/fileKinds.js";
import {
  isImageEntryName,
  listTarEntries,
  listZipEntries,
  readZipEntry,
} from "../../../lib/archiveReader.js";
import { BytesLoader } from "./bytesLoader.jsx";

/** @param {{ driveId: string, path: string }} props */
export default function ArchiveViewer({ driveId, path }) {
  const ext = fileExtension(path);
  // Only zip and plain tar have a reader here. Compressed tars, .gz/.bz2/.xz,
  // 7z, and rar would parse as garbage or fail as "damaged".
  if (ext !== "zip" && ext !== "tar") {
    return (
      <p className="text-primary text-sm">
        Luna can only list zip and tar archives. Download this file to open it on your device.
      </p>
    );
  }
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Reading archive…">
      {({ bytes }) => <ArchiveList bytes={bytes} path={path} />}
    </BytesLoader>
  );
}

ArchiveViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function ArchiveList({ bytes, path }) {
  const ext = fileExtension(path);
  const entries = useMemo(() => {
    try {
      if (ext === "tar") return listTarEntries(bytes);
      return listZipEntries(bytes);
    } catch {
      return null;
    }
  }, [bytes, ext]);

  if (!entries) {
    return (
      <p className="text-primary text-sm">
        Luna could not read this archive. Try downloading it.
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="text-primary text-sm">
        This archive is empty.
      </p>
    );
  }

  return (
    <div className="rounded-large-element surface-primary border-2 border-secondary/20 max-h-[65vh] overflow-auto">
      <ul className="divide-y divide-secondary/15">
        {entries.slice(0, 500).map((entry) => (
          <li key={entry.name} className="px-4 py-2 font-mono text-sm flex justify-between gap-3">
            <span className="break-all">{entry.name}</span>
            <span className="shrink-0 opacity-80">{formatSize(entry.size)}</span>
          </li>
        ))}
      </ul>
      {entries.length > 500 && (
        <p className="px-4 py-2 text-sm">Showing the first 500 items.</p>
      )}
    </div>
  );
}

ArchiveList.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** @param {{ driveId: string, path: string }} props */
export function ComicViewer({ driveId, path }) {
  const ext = fileExtension(path);
  if (ext === "cbr") {
    return (
      <p className="text-primary text-sm">
        Luna can open CBZ comics but not CBR. Download this file to read it in a comic app.
      </p>
    );
  }
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening comic…">
      {({ bytes }) => <ComicPager bytes={bytes} />}
    </BytesLoader>
  );
}

ComicViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function ComicPager({ bytes }) {
  const pages = useMemo(() => {
    try {
      return listZipEntries(bytes)
        .filter((e) => isImageEntryName(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    } catch {
      return [];
    }
  }, [bytes]);
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState(/** @type {string|null} */ (null));
  const [pageFailed, setPageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = /** @type {string|null} */ (null);
    (async () => {
      setPageFailed(false);
      if (!pages[index]) {
        setUrl(null);
        return;
      }
      try {
        const data = await readZipEntry(bytes, pages[index]);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([data]));
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      } catch {
        if (!cancelled) {
          setUrl(null);
          setPageFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, pages, index]);

  if (pages.length === 0) {
    return <p className="text-primary text-sm">No images found in this comic.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="rounded-pill border-2 border-secondary/30 px-4 py-2 text-sm disabled:opacity-40"
          disabled={index <= 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Previous
        </button>
        <p className="text-sm text-primary">
          Page {index + 1} of {pages.length}
        </p>
        <button
          type="button"
          className="rounded-pill border-2 border-secondary/30 px-4 py-2 text-sm disabled:opacity-40"
          disabled={index >= pages.length - 1}
          onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))}
        >
          Next
        </button>
      </div>
      {url ? (
        <img src={url} alt={`Page ${index + 1}`} className="max-h-[60vh] mx-auto object-contain" />
      ) : pageFailed ? (
        <p className="text-primary text-sm">Luna couldn&rsquo;t open this page. Download the comic to read it in a comic app.</p>
      ) : (
        <p className="text-primary text-sm">Loading page…</p>
      )}
    </div>
  );
}

ComicPager.propTypes = {
  bytes: PropTypes.any.isRequired,
};
