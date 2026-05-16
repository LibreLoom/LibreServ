import { useState, useEffect, useCallback } from "react";
import { Cloud, Plus, Loader2, Trash2, Save, Plug } from "lucide-react";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import InfoPopover from "../common/InfoPopover";

const PROVIDERS = [
  { value: "local", label: "This Device" },
  { value: "b2", label: "Backblaze B2" },
  { value: "s3", label: "S3 (AWS, MinIO, Wasabi)" },
  { value: "sftp", label: "SFTP Server" },
];

const INITIAL_FORM = {
  app_id: "",
  provider: "local",
  bucket: "",
  endpoint: "",
  region: "",
  key_id: "",
  key_secret: "",
  sftp_host: "",
  upload_limit: 0,
  download_limit: 0,
};

function inputClass() {
  return "w-full px-3 py-2 bg-primary border border-primary/20 rounded-pill font-mono text-sm text-secondary focus-visible:ring-2 focus:ring-accent";
}

export default function BackupRepoConfig() {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [repos, setRepos] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);

  const loadData = useCallback(async () => {
    try {
      const [reposRes, appsRes, capRes] = await Promise.all([
        request("/backups/repos"),
        request("/apps"),
        request("/backups/capabilities"),
      ]);
      if (reposRes.ok) {
        const data = await reposRes.json();
        setRepos(data.repositories || []);
      }
      if (appsRes.ok) {
        const data = await appsRes.json();
        setApps(data.apps || []);
      }
      if (capRes.ok) {
        setCapabilities(await capRes.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function closeModal() {
    setForm(INITIAL_FORM);
    setShowModal(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const credentials = {};
      let repoPath = "";
      const provider = form.provider;

      if (provider === "b2") {
        credentials.B2_ACCOUNT_ID = form.key_id;
        credentials.B2_ACCOUNT_KEY = form.key_secret;
        repoPath = form.bucket;
      } else if (provider === "s3") {
        credentials.AWS_ACCESS_KEY_ID = form.key_id;
        credentials.AWS_SECRET_ACCESS_KEY = form.key_secret;
        credentials.AWS_DEFAULT_REGION = form.region;
        repoPath = form.endpoint;
      } else if (provider === "sftp") {
        repoPath = form.sftp_host;
      }

      const body = {
        app_id: form.app_id || undefined,
        repo_type: provider,
        repo_path: repoPath || undefined,
        credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
        limit_upload_kbps: form.upload_limit || 0,
        limit_download_kbps: form.download_limit || 0,
      };

      const res = await request("/backups/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to add backup destination");
      }
      addToast({ type: "success", message: "Backup destination added" });
      closeModal();
      loadData();
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const credentials = {};
      let repoPath = "";
      const provider = form.provider;

      if (provider === "b2") {
        credentials.B2_ACCOUNT_ID = form.key_id;
        credentials.B2_ACCOUNT_KEY = form.key_secret;
        repoPath = form.bucket;
      } else if (provider === "s3") {
        credentials.AWS_ACCESS_KEY_ID = form.key_id;
        credentials.AWS_SECRET_ACCESS_KEY = form.key_secret;
        credentials.AWS_DEFAULT_REGION = form.region;
        repoPath = form.endpoint;
      } else if (provider === "sftp") {
        repoPath = form.sftp_host;
      }

      const res = await request("/backups/repos/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: form.app_id || undefined,
          repo_type: provider,
          repo_path: repoPath,
          credentials,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast({ type: "success", message: "Connection successful" });
      } else {
        addToast({ type: "error", message: data.message || "Connection failed" });
      }
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete(repoId) {
    setDeleting(repoId);
    try {
      const res = await request(`/backups/repos/${repoId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove destination");
      addToast({ type: "success", message: "Backup destination removed" });
      loadData();
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setDeleting(null);
    }
  }

  function providerLabel(type) {
    return PROVIDERS.find(p => p.value === type)?.label || type;
  }

  function appLabel(repo) {
    if (!repo.app_id) return "All apps (default)";
    const app = apps.find(a => a.id === repo.app_id);
    return app?.name || repo.app_id;
  }

  const canSave = form.provider === "local"
    || (form.provider === "b2" && form.bucket && form.key_id && form.key_secret)
    || (form.provider === "s3" && form.endpoint && form.key_id && form.key_secret)
    || (form.provider === "sftp" && form.sftp_host);

  if (!capabilities?.restic_available) {
    return (
      <Card icon={Cloud} title="Backup Destinations" padding={false} noPopIn>
        <div className="p-5 space-y-3">
          <p className="text-sm text-accent">
            Cloud backup destinations require restic to be installed.
          </p>
          <a
            href="https://restic.net/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
          >
            Install restic
          </a>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        icon={Cloud}
        title="Backup Destinations"
        padding={false}
        noPopIn
        headerActions={
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors"
          >
            <Plus size={14} aria-hidden="true" />
            Add
          </button>
        }
      >
        {loading ? (
          <div className="p-5 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        ) : repos.length === 0 ? (
          <div className="p-5">
            <p className="text-sm text-accent">
              Backups are stored on this device by default. Add a cloud destination for off-site copies.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-primary/10">
            {repos.map(repo => (
              <div key={repo.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm text-primary truncate">
                    {providerLabel(repo.repo_type)}
                  </div>
                  <div className="text-xs text-accent mt-0.5 flex items-center gap-2">
                    <span>{appLabel(repo)}</span>
                    {repo.repo_path && (
                      <>
                        <span>·</span>
                        <span className="truncate">{repo.repo_path}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(repo.id)}
                  disabled={deleting === repo.id}
                  title="Remove destination"
                  className="p-1.5 rounded-pill hover:bg-error/10 text-accent/50 hover:text-error transition-all disabled:opacity-50"
                  aria-label="Remove destination"
                >
                  {deleting === repo.id ? (
                    <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
                  ) : (
                    <span className="opacity-50"><Trash2 size={14} className="text-accent" aria-hidden="true" /></span>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showModal && (
        <ModalCard
          title="Add Backup Destination"
          onClose={closeModal}
          footer={
            <div className="flex gap-3 w-full">
              {form.provider !== "local" && (
                <button
                  onClick={handleTest}
                  disabled={testing || !canSave}
                  className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                  {testing ? "Testing..." : "Test Connection"}
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving || !canSave}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Add Destination
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-mono text-primary/70 mb-2">Provider</label>
              <Dropdown
                value={form.provider}
                onChange={val => setForm(f => ({
                  ...f,
                  provider: val,
                  bucket: "",
                  endpoint: "",
                  key_id: "",
                  key_secret: "",
                  region: "",
                  sftp_host: "",
                }))}
                fullWidth
                options={PROVIDERS}
                bg="primary"
              />
            </div>

            <div>
              <label className="block text-sm font-mono text-primary/70 mb-2">App</label>
              <Dropdown
                value={form.app_id}
                onChange={val => setForm(f => ({ ...f, app_id: val }))}
                placeholder="All apps (default)"
                fullWidth
                bg="primary"
                options={[
                  { value: "", label: "All apps (default)" },
                  ...apps.map(app => ({ value: app.id, label: app.name })),
                ]}
              />
            </div>

            {form.provider === "b2" && (
              <>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Bucket Name</label>
                  <input
                    type="text"
                    value={form.bucket}
                    onChange={e => setForm(f => ({ ...f, bucket: e.target.value }))}
                    placeholder="my-backup-bucket"
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Key ID</label>
                  <input
                    type="text"
                    value={form.key_id}
                    onChange={e => setForm(f => ({ ...f, key_id: e.target.value }))}
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Key Secret</label>
                  <input
                    type="password"
                    value={form.key_secret}
                    onChange={e => setForm(f => ({ ...f, key_secret: e.target.value }))}
                    className={inputClass()}
                  />
                </div>
              </>
            )}

            {form.provider === "s3" && (
              <>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Endpoint</label>
                  <input
                    type="text"
                    value={form.endpoint}
                    onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))}
                    placeholder="https://s3.amazonaws.com/my-bucket"
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Access Key</label>
                  <input
                    type="text"
                    value={form.key_id}
                    onChange={e => setForm(f => ({ ...f, key_id: e.target.value }))}
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Secret Key</label>
                  <input
                    type="password"
                    value={form.key_secret}
                    onChange={e => setForm(f => ({ ...f, key_secret: e.target.value }))}
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-mono text-primary/70 mb-2">Region</label>
                  <input
                    type="text"
                    value={form.region}
                    onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
                    placeholder="us-east-1"
                    className={inputClass()}
                  />
                </div>
              </>
            )}

            {form.provider === "sftp" && (
              <div>
                <label className="block text-sm font-mono text-primary/70 mb-2">Server Address</label>
                <input
                  type="text"
                  value={form.sftp_host}
                  onChange={e => setForm(f => ({ ...f, sftp_host: e.target.value }))}
                  placeholder="user@host:/path/to/backups"
                  className={inputClass()}
                />
              </div>
            )}

            {form.provider === "local" && (
              <p className="text-sm text-accent">
                Backups will be stored on this device with deduplication and compression.
              </p>
            )}

            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-mono text-primary/70">Upload Limit</label>
                <InfoPopover>
                  Throttle backup uploads to avoid saturating your connection. Set to 0 for no limit.
                </InfoPopover>
              </div>
              <input
                type="number"
                min="0"
                value={form.upload_limit}
                onChange={e => setForm(f => ({ ...f, upload_limit: parseInt(e.target.value) || 0 }))}
                className={inputClass()}
                placeholder="0 (no limit)"
              />
              <p className="mt-1 text-xs text-accent">KB/s — applies to cloud uploads</p>
            </div>

            <div>
              <label className="text-sm font-mono text-primary/70">Download Limit</label>
              <input
                type="number"
                min="0"
                value={form.download_limit}
                onChange={e => setForm(f => ({ ...f, download_limit: parseInt(e.target.value) || 0 }))}
                className={inputClass()}
                placeholder="0 (no limit)"
              />
              <p className="mt-1 text-xs text-accent">KB/s — applies when restoring from cloud</p>
            </div>
          </div>
        </ModalCard>
      )}
    </>
  );
}
