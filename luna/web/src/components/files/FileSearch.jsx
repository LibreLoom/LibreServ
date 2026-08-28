import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Search,
  Trash2,
} from "lucide-react";
import ModalCard from "../cards/ModalCard";
import EmptyState from "../common/EmptyState";
import PageNotice from "../common/PageNotice";
import Button from "../ui/Button";
import AccessSheet, { AccessButton } from "./AccessSheet";
import FolderPickerModal from "./FolderPickerModal";
import { apiErrorMessage, getDrives, getJson, postJson } from "../../lib/api";

function folderOf(path) {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function openHref(item) {
  if (item.kind === "dir") {
    return item.path
      ? `/drives/${item.drive_id}?path=${encodeURIComponent(item.path)}`
      : `/drives/${item.drive_id}`;
  }
  const folder = item.parent != null ? item.parent : folderOf(item.path);
  if (!folder) return `/drives/${item.drive_id}`;
  return `/drives/${item.drive_id}?path=${encodeURIComponent(folder)}`;
}

function downloadHref(item) {
  return `/api/v1/drives/${item.drive_id}/files/content?path=${encodeURIComponent(item.path)}&download=1`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

function locationLabel(item, driveLabel) {
  const folder = item.parent != null ? item.parent : folderOf(item.path);
  if (!folder) return driveLabel;
  return `${driveLabel} / ${folder}`;
}

async function parseError(res) {
  try {
    const data = await res.json();
    return data.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/**
 * Universal search across drives — files, folders, paths, and drive names.
 * Each hit includes the same actions you get on a file row (open, download,
 * share, copy, move, trash) so a match is never just a name you can't use.
 */
export default function FileSearch() {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [actionError, setActionError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyKind, setCopyKind] = useState("copy");
  const [accessTarget, setAccessTarget] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const labels = Object.fromEntries((drives.data || []).map((d) => [d.id, d.label]));

  const results = useQuery({
    queryKey: ["search", q],
    queryFn: () => getJson(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });

  const removeMutation = useMutation({
    mutationFn: async (/** @type {any} */ item) => {
      const res = await fetch(
        `/api/v1/drives/${item.drive_id}/files?path=${encodeURIComponent(item.path)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Luna couldn't move that to trash. Try again.")),
  });

  const copyMutation = useMutation({
    mutationFn: async (/** @type {{ driveId: string, path: string }} */ dest) => {
      return postJson("/api/v1/jobs", {
        kind: copyKind,
        from_drive: copyTarget.drive_id,
        from_path: copyTarget.path,
        to_drive: dest.driveId || copyTarget.drive_id,
        to_path: dest.path,
      });
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["search"] });
    },
    onError: (err) =>
      setActionError(
        apiErrorMessage(
          err,
          copyKind === "move"
            ? "Luna couldn't start moving that. Try again."
            : "Luna couldn't start copying that. Try again."
        )
      ),
  });

  return (
    <div className="mb-6" data-slot="file-search">
      <label className="block">
        <span className="sr-only">Search for a file</span>
        <span className="flex items-center gap-3 rounded-pill bg-secondary text-primary border-2 border-transparent px-4 py-2 focus-within:border-accent motion-safe:transition-colors">
          <Search size={16} className="text-accent shrink-0" aria-hidden="true" />
          <input
            className="file-search-input flex-1 min-w-0 appearance-none bg-transparent text-primary text-sm border-0 shadow-none outline-none no-focus-outline placeholder:text-accent"
            placeholder="Search for a file"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Search for a file"
          />
        </span>
      </label>

      {actionError && (
        <PageNotice variant="error" className="mt-3">
          {actionError}
        </PageNotice>
      )}

      {q.length >= 2 && results.isError && (
        <p className="text-error text-xs mt-2">
          {apiErrorMessage(results.error, "Luna couldn't search right now. Try again.")}
        </p>
      )}

      {q.length >= 2 && results.isLoading && (
        <p className="text-secondary text-xs mt-3">Searching…</p>
      )}

      {q.length >= 2 && !results.isLoading && (results.data || []).length === 0 && (
        <EmptyState
          className="mt-3"
          title="Nothing matched"
          description="Try another name, or open a drive and browse. Luna only shows files you're allowed to see."
        />
      )}

      {(results.data || []).length > 0 && (
        <ul className="mt-3 grid gap-2">
          {results.data.map((item) => {
            const driveLabel = labels[item.drive_id] || "A drive";
            const isDir = item.kind === "dir";
            return (
              <li key={`${item.drive_id}:${item.path}`}>
                <div className="rounded-large-element bg-secondary text-primary px-3 py-2 motion-safe:transition-shadow hover:ring-2 hover:ring-accent">
                  <div className="flex items-center gap-2 min-w-0">
                    {isDir ? (
                      <Folder size={16} className="text-accent shrink-0" aria-hidden="true" />
                    ) : (
                      <FileIcon size={16} className="text-accent shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm truncate text-primary">{item.name}</p>
                      <p className="text-xs truncate text-primary">
                        {locationLabel(item, driveLabel)}
                        {!isDir && item.size != null ? ` · ${fmtSize(item.size)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        asChild
                        aria-label={isDir ? `Open ${item.name}` : `Go to folder for ${item.name}`}
                      >
                        <Link to={openHref(item)}>
                          <FolderOpen size={14} />
                        </Link>
                      </Button>
                      {!isDir && (
                        <Button
                          variant="ghost"
                          surface="secondary"
                          size="iconSm"
                          asChild
                          aria-label={`Download ${item.name}`}
                        >
                          <a href={downloadHref(item)}>
                            <Download size={14} />
                          </a>
                        </Button>
                      )}
                      <AccessButton
                        label={item.name}
                        surface="secondary"
                        onClick={() =>
                          setAccessTarget({
                            driveId: item.drive_id,
                            path: item.path,
                            kind: isDir ? "folder" : "file",
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        aria-label={`Copy ${item.name}`}
                        onClick={() => {
                          setCopyKind("copy");
                          setCopyTarget(item);
                          setActionError(null);
                        }}
                      >
                        <Copy size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        aria-label={`Move ${item.name}`}
                        onClick={() => {
                          setCopyKind("move");
                          setCopyTarget(item);
                          setActionError(null);
                        }}
                      >
                        <FolderInput size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        aria-label={`Move ${item.name} to trash`}
                        onClick={() => {
                          setDeleteTarget(item);
                          setActionError(null);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ModalCard
        open={deleteTarget != null}
        title="Move to trash?"
        onClose={() => setDeleteTarget(null)}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              <span className="font-mono">{deleteTarget?.name}</span> will move to
              Luna&apos;s trash on its drive. You can get it back later from Open trash.
            </p>
            {actionError && <PageNotice variant="error" className="mt-2">{actionError}</PageNotice>}
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={removeMutation.isPending}
                onClick={() => {
                  if (!deleteTarget) return;
                  removeMutation.mutateAsync(deleteTarget)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Move to trash
              </Button>
              <Button variant="outline" onClick={close}>
                Keep it
              </Button>
            </div>
          </>
        )}
      </ModalCard>

      <FolderPickerModal
        open={copyTarget != null}
        title={copyKind === "move" ? `Move ${copyTarget?.name || ""}` : `Copy ${copyTarget?.name || ""}`}
        drives={drives.data || []}
        initialDriveId={copyTarget?.drive_id || ""}
        initialPath={copyTarget ? (copyTarget.parent != null ? copyTarget.parent : folderOf(copyTarget.path)) : ""}
        confirmLabel={copyKind === "move" ? "Start moving" : "Start copying"}
        busy={copyMutation.isPending}
        onClose={() => setCopyTarget(null)}
        onConfirm={(dest, close) => {
          copyMutation.mutateAsync(dest)
            .then(() => close())
            .catch(() => {});
        }}
      />

      <AccessSheet
        open={accessTarget != null}
        driveId={accessTarget?.driveId || ""}
        path={accessTarget?.path || ""}
        kind={accessTarget?.kind || "folder"}
        onClose={() => setAccessTarget(null)}
      />
    </div>
  );
}
