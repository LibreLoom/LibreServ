import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  File as FileIcon,
  Folder,
  HardDrive,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import ModalErrorNotice from "../components/common/ModalErrorNotice";
import { showPageLevelError } from "../lib/modalScopedError";
import FileSearch from "../components/files/FileSearch";
import DriveFileExplorer from "../components/files/DriveFileExplorer";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  getJson,
  postJson,
} from "../lib/api";
import { folderHref, fmtSize } from "../lib/paths";
import { useAuth } from "../context/AuthContext";
import { hasWriteOnDrive } from "../lib/shareTree.js";

function jobBusy(job) {
  return job.state === "running" || job.state === "queued";
}

export default function FilesPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const path = searchParams.get("path") || "";
  const inTrash = searchParams.get("view") === "trash";
  const [actionError, setActionError] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreName, setRestoreName] = useState("");
  const [purgeTarget, setPurgeTarget] = useState(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);
  const grants = useQuery({
    queryKey: ["grants"],
    queryFn: () => getJson("/api/v1/grants"),
    enabled: !isAdmin,
  });
  const canOpenTrash = isAdmin || hasWriteOnDrive(grants.data, id);

  const trash = useQuery({
    queryKey: ["trash", id],
    queryFn: () => getJson(`/api/v1/drives/${id}/trash`),
    enabled: !!drive && inTrash,
  });

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson("/api/v1/jobs"),
    refetchInterval: (q) => ((q.state.data || []).some(jobBusy) ? 1000 : false),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["files", id] });
    queryClient.invalidateQueries({ queryKey: ["trash", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const restoreMutation = useMutation({
    mutationFn: (/** @type {any} */ item) =>
      postJson(`/api/v1/drives/${id}/files/restore`, {
        path: item.path,
        dest: restoreName,
      }),
    onSuccess: () => { invalidate(); },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't restore that. Try again.")),
  });

  const purgeMutation = useMutation({
    mutationFn: (/** @type {any} */ item) =>
      postJson(`/api/v1/drives/${id}/files/purge`, { path: item.path }),
    onSuccess: () => { invalidate(); },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't permanently delete that. Try again.")),
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId) => deleteJson(`/api/v1/jobs/${jobId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't cancel that job. Try again.")),
  });

  const activeJobs = (jobs.data || []).filter(jobBusy);
  const trashItems = trash.data || [];

  const trashModalOpen = restoreTarget != null || purgeTarget != null;

  return (
    <Page
      title={inTrash ? "Trash" : (drive ? drive.label : "Files")}
      titleId="files-title"
      rightContent={<FileSearch />}
    >
      {activeJobs.length > 0 && (
        <div className="grid gap-3 mb-4">
          {activeJobs.map((job) => (
            <Card key={job.id} padding>
              <p className="text-primary text-sm font-mono">
                {job.kind === "move" ? "Moving" : "Copying"} {job.from_path || "a file"}
              </p>
              <p className="text-primary text-xs mt-1">
                {job.total > 0
                  ? `${Math.min(100, Math.round((100 * job.progress) / job.total))}% done`
                  : "Starting…"}
              </p>
              <div className="mt-2 h-2 rounded-pill bg-primary overflow-hidden" aria-hidden="true">
                <div
                  className="h-full bg-accent motion-safe:transition-all"
                  style={{ width: `${job.total > 0 ? Math.min(100, (100 * job.progress) / job.total) : 8}%` }}
                />
              </div>
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  loading={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(job.id)}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {inTrash ? (
        <Card className="mb-4" padding>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-primary">
            <Button variant="ghost" surface="secondary" size="sm" asChild>
              <Link to={folderHref(id, "")}>{drive?.label || "Drive"}</Link>
            </Button>
            <span className="flex items-center gap-2">
              <span className="text-accent">/</span>
              <span>Trash</span>
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" surface="secondary" size="sm" asChild>
              <Link to={`/drives/${id}`}>Back to files</Link>
            </Button>
          </div>
        </Card>
      ) : null}

      {showPageLevelError(actionError, trashModalOpen) && (
        <PageNotice variant="error" className="mb-4">{actionError}</PageNotice>
      )}

      {!drives.isLoading && !drive && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive not found"
          description="Luna couldn't find this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/drives">Go to Drives</Link>
            </Button>
          }
        />
      )}

      {!inTrash && drive && drive.state === "missing" && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive unplugged"
          description="This drive is unplugged. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/drives">Go to Drives</Link>
            </Button>
          }
        />
      )}

      {!inTrash && drive && drive.state !== "missing" && (
        <DriveFileExplorer
          driveId={id}
          driveLabel={drive.label}
          path={path}
          onPathChange={(next) => {
            const params = new URLSearchParams(searchParams);
            if (next) params.set("path", next);
            else params.delete("path");
            params.delete("view");
            setSearchParams(params, { replace: true });
          }}
          linkNavigation
          folderHref={folderHref}
          isAdmin={isAdmin}
          showTrashLink={canOpenTrash}
        />
      )}

      {inTrash && canOpenTrash && (
        <div className="rounded-large-element bg-secondary text-primary overflow-hidden">
          {trashItems.map((item) => (
              <div
                key={item.path}
                className="flex items-center justify-between px-3 py-2.5 gap-2 bg-secondary text-primary border-b border-primary/15 last:border-b-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {item.kind === "dir" ? (
                    <Folder size={16} className="text-accent shrink-0" />
                  ) : (
                    <FileIcon size={16} className="text-accent shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-mono text-sm truncate">{item.original_name || item.name}</p>
                    <p className="text-xs">{fmtSize(item.size)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Put ${item.original_name} back`}
                    onClick={() => {
                      setRestoreTarget(item);
                      setRestoreName(item.original_name || item.name);
                    }}
                  >
                    <RotateCcw size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Delete ${item.original_name} forever`}
                    onClick={() => setPurgeTarget(item)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
          ))}
        </div>
      )}

      {inTrash && !canOpenTrash && !grants.isLoading && (
        <EmptyState
          className="mt-4"
          icon={Trash2}
          title="Trash isn't available here"
          description="You need Write access somewhere on this drive to open trash."
        />
      )}

      {inTrash && canOpenTrash && !trash.isLoading && trashItems.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={Trash2}
          title="Trash is empty"
        />
      )}

      <ModalCard
        open={restoreTarget != null}
        title="Put this back?"
        onClose={() => {
          setActionError(null);
          setRestoreTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              Luna will move it out of trash on this same drive. Choose the name it should have.
            </p>
            <input
              className="mt-3 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
              value={restoreName}
              onChange={(e) => setRestoreName(e.target.value)}
              aria-label="Restored file name"
            />
            {actionError && <ModalErrorNotice error={actionError} />}
            <div className="mt-4 flex gap-3">
              <Button
                variant="primary"
                loading={restoreMutation.isPending}
                onClick={() => {
                  if (!restoreTarget) return;
                  restoreMutation.mutateAsync(restoreTarget)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Put it back
              </Button>
              <Button variant="outline" onClick={close}>Not now</Button>
            </div>
          </>
        )}
      </ModalCard>

      <ModalCard
        open={purgeTarget != null}
        title="Delete forever?"
        onClose={() => {
          setActionError(null);
          setPurgeTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              <span className="font-mono">{purgeTarget?.original_name}</span> will be
              removed for good. Luna cannot get it back after this.
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={purgeMutation.isPending}
                onClick={() => {
                  if (!purgeTarget) return;
                  purgeMutation.mutateAsync(purgeTarget)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Delete forever
              </Button>
              <Button variant="outline" onClick={close}>Keep in trash</Button>
            </div>
          </>
        )}
      </ModalCard>
    </Page>
  );
}
