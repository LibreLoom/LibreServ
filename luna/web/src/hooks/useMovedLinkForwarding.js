import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { getJson } from "../lib/api";
import { driveSource, fileListKey } from "../lib/fileSource.jsx";
import { fileHref, folderHref, isTrashPath, parentPath, pathBasename } from "../lib/paths";

/**
 * Deepest-first places this URL names that turned out to be missing, or
 * `[]` while everything is where the link says.
 *
 * @param {{ path: string, viewerPath: string | null, selectPath: string,
 *   listingMissing: boolean, entries: object[] | undefined }} args
 * @returns {string[]}
 */
export function missingLinkTargets({ path, viewerPath, selectPath, listingMissing, entries }) {
  const leaf = [viewerPath, selectPath].find(
    (p) => p && parentPath(p) === path,
  );
  if (listingMissing) {
    return [...new Set([leaf, path].filter(Boolean))];
  }
  if (!leaf || !entries) return [];
  const name = pathBasename(leaf);
  return entries.some((e) => e?.name === name) ? [] : [leaf];
}

/**
 * Where a forwarded item should open, keeping what the old link did: a
 * `?file=` link opens the viewer, a `?select=` link highlights the row, a
 * folder link browses the folder.
 */
export function forwardedHref({ drive_id: driveId, path, kind }, from, { viewerPath }) {
  if (kind === "dir") return folderHref(driveId, path);
  if (from === viewerPath) return fileHref(driveId, path);
  const base = folderHref(driveId, parentPath(path) ?? "");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}select=${encodeURIComponent(path)}`;
}

/**
 * Old links keep working after a move or rename: when the folder or file a
 * `/drives/:id` URL names is gone, ask Luna where it went and replace the
 * URL with its new address. Reads FileBrowser's cached listing, so this
 * costs nothing until something is actually missing.
 *
 * @param {{ driveId: string, path: string, viewerPath: string | null,
 *   selectPath: string, enabled: boolean }} args
 */
export default function useMovedLinkForwarding({ driveId, path, viewerPath, selectPath, enabled }) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  // Trash has its own lifecycle; nothing is forwarded into or out of it.
  const active = enabled && Boolean(driveId) && !isTrashPath(path);

  // Watch FileBrowser's listing without ever fetching it here: some views
  // (upload-only drop boxes) must never list, and the explorer knows which.
  const listing = useQuery({
    queryKey: fileListKey(driveSource, driveId, path),
    queryFn: () => driveSource.listDir(driveId, path),
    enabled: false,
  });

  const listingMissing = Boolean(
    path && listing.isError && /** @type {any} */ (listing.error)?.code === "not_found",
  );

  const targets = useMemo(
    () => (active
      ? missingLinkTargets({ path, viewerPath, selectPath, listingMissing, entries: listing.data })
      : []),
    [active, path, viewerPath, selectPath, listingMissing, listing.data],
  );

  const forward = useQuery({
    queryKey: ["moved-link", driveId, targets],
    queryFn: async () => {
      for (const from of targets) {
        try {
          const hit = await getJson(
            `/api/v1/drives/${driveId}/files/resolve?path=${encodeURIComponent(from)}`,
          );
          return { from, hit };
        } catch (err) {
          if (/** @type {any} */ (err)?.status !== 404) throw err;
        }
      }
      return null;
    },
    enabled: targets.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  const followed = useRef("");
  useEffect(() => {
    const result = forward.data;
    if (!result) return;
    const href = forwardedHref(result.hit, result.from, { viewerPath });
    if (followed.current === href) return;
    followed.current = href;
    navigate(href, { replace: true });
    addToast({
      type: "info",
      message: result.hit.kind === "dir" ? "This folder has moved." : "This file has moved.",
      description: "Luna opened it in its new place. Update any bookmarks to this page.",
    });
  }, [forward.data, viewerPath, navigate, addToast]);

  return { forwarding: forward.isFetching };
}
