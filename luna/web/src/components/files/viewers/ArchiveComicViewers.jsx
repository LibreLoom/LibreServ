import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { fileExtension } from "../../../lib/fileKinds.js";
import {
  isImageEntryName,
  listTarEntries,
  listZipEntries,
  readZipEntry,
} from "../../../lib/archiveReader.js";
import { BytesLoader } from "./bytesLoader.jsx";

const ARCHIVE_PAGE_SIZE = 100;
const ARCHIVE_PREVIEW_LIMIT = 500;
const PAGE_ORDER = new Intl.Collator(undefined, { numeric: true });
const COMIC_CACHE_SIZE = 3;

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
  const [page, setPage] = useState(0);
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
  const count = Math.min(entries.length, ARCHIVE_PREVIEW_LIMIT);
  const start = page * ARCHIVE_PAGE_SIZE;
  const end = Math.min(count, start + ARCHIVE_PAGE_SIZE);

  return (
    <div className="space-y-2">
      {count > ARCHIVE_PAGE_SIZE && (
        <nav aria-label="Archive pages" className="flex items-center justify-end gap-2">
          <span className="text-sm" role="status">{start + 1}–{end} of {count}</span>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={end === count} onClick={() => setPage(page + 1)}>Next</Button>
        </nav>
      )}
      <div key={page} className="rounded-large-element surface-primary border-2 border-secondary/20 max-h-[65vh] overflow-auto">
        <ul className="divide-y divide-secondary/15">
          {entries.slice(start, end).map((entry, index) => (
            <li key={start + index} className="px-4 py-2 font-mono text-sm flex justify-between gap-3">
              <span className="break-all">{entry.name}</span>
              <span className="shrink-0 opacity-80">{formatSize(entry.size)}</span>
            </li>
          ))}
        </ul>
        {entries.length > ARCHIVE_PREVIEW_LIMIT && (
          <p className="px-4 py-2 text-sm">Showing the first 500 items.</p>
        )}
      </div>
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
        .sort((a, b) => PAGE_ORDER.compare(a.name, b.name));
    } catch {
      return [];
    }
  }, [bytes]);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(/** @type {{ index: number, url: string }|null} */ (null));
  const [failedIndex, setFailedIndex] = useState(-1);
  const cached = useRef(/** @type {Map<number, string>} */ (new Map()));

  useLayoutEffect(() => {
    const cache = cached.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  useEffect(() => {
    const request = new AbortController();
    let pendingUrl = null;
    (async () => {
      if (!pages[index]) return;
      let url = cached.current.get(index);
      try {
        if (!url) {
          const data = await readZipEntry(bytes, pages[index], request.signal);
          if (request.signal.aborted) return;
          url = URL.createObjectURL(new Blob([data]));
          pendingUrl = url;
          const image = new Image();
          image.src = url;
          if (typeof image.decode === "function") await image.decode();
        }
        if (request.signal.aborted) return;
        cached.current.delete(index);
        cached.current.set(index, url);
        if (cached.current.size > COMIC_CACHE_SIZE) {
          const oldest = cached.current.keys().next().value;
          URL.revokeObjectURL(cached.current.get(oldest));
          cached.current.delete(oldest);
        }
        setFailedIndex(-1);
        setShown({ index, url });
        pendingUrl = null;
      } catch {
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
        pendingUrl = null;
        if (!request.signal.aborted) setFailedIndex(index);
      }
    })();
    return () => {
      request.abort();
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingUrl = null;
    };
  }, [bytes, pages, index]);

  if (pages.length === 0) {
    return <p className="text-primary text-sm">No images found in this comic.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          disabled={index <= 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Previous
        </Button>
        <p className="text-sm text-primary" role="status">
          Page {index + 1} of {pages.length}
        </p>
        <Button
          variant="outline"
          disabled={index >= pages.length - 1}
          onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))}
        >
          Next
        </Button>
      </div>
      {shown && (
        <img src={shown.url} alt={`Page ${shown.index + 1}`} className="max-h-[60vh] mx-auto object-contain" />
      )}
      {failedIndex === index ? (
        <p className="text-primary text-sm">Luna couldn&rsquo;t open this page. Download the comic to read it in a comic app.</p>
      ) : shown?.index !== index ? (
        <p className="text-primary text-sm">Loading page…</p>
      ) : null}
    </div>
  );
}

ComicPager.propTypes = {
  bytes: PropTypes.any.isRequired,
};
