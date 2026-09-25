import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { canViewerOpen } from "../lib/officeConvert.js";
import { viewerNeedsSession } from "../lib/fileKinds.js";
import { isTrashPath, joinPath, parentPath, pathBasename, TRASH_PATH } from "../lib/paths.js";

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** @param {{ defaultFile?: string | null, singleFile?: boolean }} [opts] */
export default function useFileNavigation({ defaultFile = null, singleFile = false } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [singleClosed, setSingleClosed] = useState(false);

  const rawPath = searchParams.get("path") || "";
  // `?view=trash` is the old link shape — trash is just the `.luna-trash`
  // folder now, so the alias folds into the regular path.
  const legacyTrash = searchParams.get("view") === "trash";
  const path = singleFile ? "" : (legacyTrash && !rawPath ? TRASH_PATH : rawPath);
  const selectPath = searchParams.get("select") || "";
  const inTrash = isTrashPath(path);
  const fileParam = searchParams.get("file") || searchParams.get("open") || "";
  const rawHash = location.hash ? safeDecode(location.hash.replace(/^#/, "")) : "";
  const hashCandidate = rawHash && rawHash !== "main-content" ? rawHash : "";
  const candidateFile = fileParam || hashCandidate;

  const viewerPath = useMemo(() => {
    if (singleFile) {
      return singleClosed && !fileParam ? null : defaultFile;
    }
    if (!candidateFile) return null;
    const name = pathBasename(candidateFile);
    // Trash is read-only: preview kinds open fine, but office, forms, and
    // diagrams need a writable editor session — they stay closed there.
    if (!name || !canViewerOpen(name) || (inTrash && viewerNeedsSession(name))) {
      return null;
    }
    if (candidateFile.includes("/")) {
      return candidateFile;
    }
    return joinPath(path, candidateFile);
  }, [singleFile, singleClosed, fileParam, defaultFile, inTrash, candidateFile, path]);

  const onViewerPathChange = useCallback((next) => {
    if (singleFile) {
      setSingleClosed(next == null);
      if (next == null && (searchParams.has("file") || searchParams.has("open"))) {
        const params = new URLSearchParams(searchParams);
        params.delete("file");
        params.delete("open");
        setSearchParams(params, { replace: true });
      }
      return;
    }
    const params = new URLSearchParams(searchParams);
    if (next) {
      const fileName = pathBasename(next);
      params.set("file", fileName);
      const dir = parentPath(next);
      if (dir !== null && dir !== path) {
        if (dir) params.set("path", dir);
        else params.delete("path");
      }
      params.delete("select");
      params.delete("view");
      params.delete("open");
      setSearchParams(params);
    } else {
      params.delete("file");
      params.delete("open");
      const search = params.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : "", hash: "" },
        { replace: true },
      );
    }
  }, [singleFile, searchParams, setSearchParams, navigate, location.pathname, path]);

  const onPathChange = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next && !singleFile) params.set("path", next);
    else params.delete("path");
    params.delete("view");
    params.delete("select");
    params.delete("file");
    params.delete("open");
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams, singleFile]);

  const clearSelectParam = useCallback(() => {
    if (!searchParams.has("select")) return;
    const params = new URLSearchParams(searchParams);
    params.delete("select");
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  return {
    path,
    selectPath,
    inTrash,
    viewerPath,
    onPathChange,
    onViewerPathChange,
    clearSelectParam,
  };
}
