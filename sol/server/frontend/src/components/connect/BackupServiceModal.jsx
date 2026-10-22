import { useState, useEffect } from "react";
import { Database, Check, Plus, Trash2, AlertTriangle } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";
import RecoveryKeyCard from "./RecoveryKeyCard.jsx";
import api from "../../lib/api.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

export default function BackupServiceModal({ open, onClose, onSaved, service, repos, connectStatus = null, csrfToken = "", loading = false }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [repoType, setRepoType] = useState("s3");
  const [repoPath, setRepoPath] = useState("");
  const [credentials, setCredentials] = useState({});
  const [repoPending, setRepoPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Fresh repo list fetched on open (the repos prop can be stale right after
  // enabling Connect storage, since BackupsCategory only reloads on mount).
  const [freshRepos, setFreshRepos] = useState([]);

  useEffect(() => {
    if (!open) return;
    setUseConnect(service?.state === "connected");
    setError(null);
    api("/backups/repos")
      .then((res) => {
        if (!res.ok) throw new Error("Could not load backup destinations.");
        return res.json();
      })
      .then((data) => setFreshRepos(data.repositories || []))
      .catch(() => setFreshRepos(repos || []));
  }, [open, service, repos]);

  if (!open) return null;

  const connectWarning = getConnectWarning("backup", connectStatus);
  const backupOnPlan = service?.state !== "unavailable";
  // The Connect-provisioned repo is the default one (no app assignment).
  const connectRepo = useConnect && service?.state === "connected"
    ? freshRepos.find((r) => !r.app_id) || null
    : null;
  const customRepos = freshRepos.filter((r) => r !== connectRepo);

  const credentialFields = {
    s3: [
      ["AWS_ACCESS_KEY_ID", "Access key"],
      ["AWS_SECRET_ACCESS_KEY", "Secret key"],
      ["AWS_DEFAULT_REGION", "Region"],
    ],
    b2: [["B2_ACCOUNT_ID", "Account ID"], ["B2_ACCOUNT_KEY", "Application key"]],
    sftp: [],
    local: [],
  }[repoType];

  async function reloadRepos() {
    const response = await api("/backups/repos");
    if (!response.ok) throw new Error("Could not refresh backup destinations.");
    const data = await response.json();
    setFreshRepos(data.repositories || []);
  }

  async function createRepo() {
    setError(null);
    const path = repoPath.trim();
    if (!path) { setError("Enter a backup destination."); return; }
    if (repoType === "s3" && !/^s3:/i.test(path)) { setError("Enter an S3 bucket path, such as s3:s3.amazonaws.com/bucket."); return; }
    if (repoType === "b2" && !/^b2:/i.test(path)) { setError("Enter a B2 bucket path, such as b2:bucket-name."); return; }
    if (repoType === "sftp" && !/^sftp:/i.test(path)) { setError("Enter an SFTP path, such as sftp:backup@example.com:/backups."); return; }
    if (repoType === "local" && !path.startsWith("/")) { setError("Enter a full folder path starting with /."); return; }
    const required = { s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], b2: ["B2_ACCOUNT_ID", "B2_ACCOUNT_KEY"] }[repoType] || [];
    if (required.some((key) => !credentials[key]?.trim())) { setError("Fill in the required sign-in details."); return; }
    setRepoPending(true);
    try {
      const response = await api("/backups/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo_type: repoType, repo_path: path, credentials: Object.fromEntries(Object.entries(credentials).filter(([, value]) => value.trim())) }) });
      if (!response.ok) throw new Error("Could not save this backup destination. Check the details and try again.");
      await reloadRepos();
      setRepoPath(""); setCredentials({}); setShowAddRepo(false);
    } catch (e) { setError(e?.message || "Could not save this backup destination. Please try again."); }
    finally { setRepoPending(false); }
  }

  async function deleteRepo() {
    if (!deleteTarget) return;
    setRepoPending(true); setError(null);
    try {
      const response = await api(`/backups/repos/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete this backup destination. Please try again.");
      await reloadRepos(); setDeleteTarget(null);
    } catch (e) { setError(e?.message || "Could not delete this backup destination. Please try again."); }
    finally { setRepoPending(false); }
  }

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring your own"
        : service?.state === "unavailable"
          ? "Not in Plan"
          : "Disabled";

  return (
    <>
    <ModalCard title="Cloud backup storage" onClose={onClose} size="lg" loading={loading} data-slot="backup-service-modal">
      {({close}) => (
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Database size={ICON_SIZE.lg} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm mt-1.5">
              Your backups need a place to live. You can use multiple destinations —
              Connect storage alongside your own S3, B2, or SFTP endpoints.
            </p>
          </div>
        </div>

        {backupOnPlan && connectStatus?.connected && (
          <div className="bg-primary/5 rounded-pill p-4">
            <p className="text-sm text-primary flex items-center gap-2">
              <Check size={ICON_SIZE.md} />
              Connect backup storage available on your plan
            </p>
          </div>
        )}

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use Sol Connect for backups"
          description={
            useConnect
              ? "Your backups will be stored on Connect's S3-compatible storage."
              : "Configure your own backup destinations below."
          }
        />

        {useConnect && connectWarning.show ? (
          <div className="surface-primary border-2 border-warning/20 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-secondary">
              <AlertTriangle size={ICON_SIZE.md} className="text-warning shrink-0" />
              {connectWarning.label}
            </div>
            <p className="text-xs">
              Connect needs to be connected and your plan must support this service
              before backup storage can be managed automatically.
            </p>
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-primary font-medium">
              Backup destinations
            </span>
            <Button variant="primary" size="sm" onClick={() => setShowAddRepo(true)}>
              <Plus size={ICON_SIZE.sm} /> Add Destination
            </Button>
          </div>

          {showAddRepo && (
              <div className="p-3 rounded-large-element border-2 border-accent/20 surface-primary space-y-3">
              <p className="text-sm text-primary">Add a new backup destination</p>
              <label className="block space-y-1 text-sm">Storage type
                <Dropdown value={repoType} bg="primary" onChange={(value) => { setRepoType(value); setCredentials({}); }} options={[{ value: "s3", label: "S3" }, { value: "b2", label: "Backblaze B2" }, { value: "sftp", label: "SFTP" }, { value: "local", label: "Folder on this device" }]} fullWidth />
              </label>
              <label className="block space-y-1 text-sm">{repoType === "local" ? "Folder path" : repoType === "sftp" ? "SFTP destination" : "Bucket path"}
                <input className="w-full rounded-large-element border border-secondary/20 surface-primary px-3 py-2 focus:border-accent" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder={repoType === "s3" ? "s3:s3.amazonaws.com/bucket" : repoType === "b2" ? "b2:bucket-name" : repoType === "sftp" ? "sftp:backup@example.com:/backups" : "/path/to/backups"} />
              </label>
              {repoType === "sftp" && <p className="text-xs">This Sol must already have an SSH (secure remote sign-in) key that the SFTP server trusts.</p>}
              {credentialFields.map(([key, label]) => <label key={key} className="block space-y-1 text-sm">{label}
                <input className="w-full rounded-large-element border border-secondary/20 surface-primary px-3 py-2 focus:border-accent" type={/SECRET|KEY|PASSWORD/.test(key) ? "password" : "text"} value={credentials[key] || ""} onChange={(e) => setCredentials({ ...credentials, [key]: e.target.value })} autoComplete="off" />
              </label>)}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowAddRepo(false)} disabled={repoPending}>Cancel</Button>
                <Button size="sm" onClick={createRepo} loading={repoPending} disabled={repoPending}>Save destination</Button>
              </div>
            </div>
          )}

          {useConnect && (
            <>
              <div className="flex items-center gap-3 p-3 rounded-large-element surface-primary border-2 border-accent/20">
                <Check size={ICON_SIZE.md} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-secondary font-medium">Connect storage</p>
                  <p className="text-xs">S3-compatible</p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-chip surface-secondary font-medium">
                  Connect
                </span>
              </div>
              {connectRepo ? (
                <RecoveryKeyCard repo={connectRepo} repoId={connectRepo.id} />
              ) : (
                <div className="surface-primary border-2 border-warning/20 rounded-large-element p-4 space-y-2">
                  <p className="text-sm text-secondary font-medium">
                    Backup recovery key
                  </p>
                  <p className="text-xs">
                    Your recovery key will appear here once Connect storage is provisioned.
                    Without this key, you cannot restore your backups on a new server.
                  </p>
                </div>
              )}
            </>
          )}

          {customRepos.length > 0 ? (
            customRepos.map((repo, i) => (
              <div
                key={repo.id || i}
                className="flex items-center gap-3 p-3 rounded-large-element surface-primary border-2 border-secondary/10"
              >
                <Database size={ICON_SIZE.md} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-secondary">{repo.name || repo.repo_type}</p>
                  <p className="text-xs truncate"><InlinePill>{repo.repo_path}</InlinePill></p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-chip border border-accent font-medium capitalize">
                  {repo.repo_type}
                </span>
                <Button type="button" variant="ghost" surface="primary" size="sm" aria-label={`Delete ${repo.repo_type} destination`} disabled={repoPending} onClick={() => setDeleteTarget(repo)}>
                  <Trash2 size={ICON_SIZE.sm} />
                </Button>
              </div>
            ))
          ) : (
            <p className="text-xs py-2">
              No custom backup destinations configured yet.
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="bg-error/20 border border-error/30 text-primary rounded-large-element p-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await updateConnectService("backup", useConnect ? "connected" : "byo", csrfToken);
              if (onSaved) await onSaved();
              close();
            } catch (e) {
              const msg = e?.message || "Something went wrong while saving. Please try again.";
              setError(msg);
              console.error("Failed to save backup config:", e);
            } finally {
              setSaving(false);
            }
          }} disabled={saving} loading={saving}>
            Save
          </Button>
        </div>
      </div>
      )}
    </ModalCard>
    <ConfirmModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={deleteRepo} icon={Trash2} title="Delete this backup destination?" message="This removes the saved destination. Backups already stored there are not deleted." variant="danger" confirmLabel="Delete destination" loading={repoPending} />
    </>
  );
}
