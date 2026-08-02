import { useState, useCallback, useEffect } from "react";
import { Database, RefreshCw, CheckCircle, AlertCircle, Loader2, Plus, Trash2, Package } from "lucide-react";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import api from "../../../lib/api";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ModalCard from "../../cards/ModalCard";
import ConfirmModal from "../../cards/ConfirmModal";

const inputClasses =
  "w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-secondary/50 focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent";

function AddRepoModal({ onClose, onAdded }) {
  const { request } = useAuth();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [priority, setPriority] = useState(10);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const handleAdd = useCallback(async () => {
    if (!url.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const csrfRes = await api("/auth/csrf");
      const csrfData = await csrfRes.json();
      const res = await request("/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfData.csrf_token,
        },
        body: JSON.stringify({ url: url.trim(), branch, priority }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add app source");
      }
      onAdded?.();
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }, [url, branch, priority, request, onAdded, onClose]);

  return (
    <ModalCard title="Add an app source" onClose={onClose} size="sm">
      {({ close }) => (
      <div className="space-y-4">
        <p className="text-sm text-primary">
          LibreServ finds apps to install by downloading app lists from the
          internet. Each list lives at a web address. Paste one below and
          new apps will appear in your app store.
        </p>

        <div>
          <label htmlFor="repo-url" className="text-sm text-primary block mb-1">
            App list address
          </label>
          <input
            id="repo-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/app-list"
            className={inputClasses}
            disabled={adding}
            autoFocus
          />
          <p className="text-xs text-primary mt-1.5">
            The person who made the app list gives you this address. It starts
            with https://
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="repo-branch" className="text-sm text-primary block mb-1">
              Version name
            </label>
            <input
              id="repo-branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className={inputClasses}
              disabled={adding}
            />
            <p className="text-xs text-primary mt-1.5">
              Leave this as &quot;main&quot; unless you were told otherwise.
            </p>
          </div>
          <div>
            <label htmlFor="repo-priority" className="text-sm text-primary block mb-1">
              Priority
            </label>
            <input
              id="repo-priority"
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              min={1}
              className={inputClasses}
              disabled={adding}
            />
            <p className="text-xs text-primary mt-1.5">
              If two lists offer the same app, the lower number wins.
            </p>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-error/20 border border-error/30 rounded-large-element">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
              <span className="text-sm text-error">{error}</span>
            </div>
          </div>
        )}

        <p className="text-xs text-primary">
          New apps will show up after LibreServ restarts.
        </p>

        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            onClick={close}
            disabled={adding}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            variant="accent"
            onClick={handleAdd}
            disabled={!url.trim() || adding}
            loading={adding}
            className="flex-1"
          >
            {adding ? "Adding..." : "Add app source"}
          </Button>
        </div>
      </div>
      )}
    </ModalCard>
  );
}

export default function RepoStatusCard({ index = 0 }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [repoToRemove, setRepoToRemove] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setFetchError(false);
      const res = await request("/repos/status");
      if (res.ok) {
        const data = await res.json();
        setRepos(data || []);
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    try {
      const csrfRes = await api("/auth/csrf");
      const csrfData = await csrfRes.json();
      const res = await request("/repos/pull", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfData.csrf_token },
      });
      if (res.ok) {
        addToast({ type: "success", message: "App catalog refreshed", description: "Your app list is up to date" });
        fetchStatus();
      } else {
        const err = await res.json();
        addToast({ type: "error", message: "Refresh failed", description: err.error || "Unknown error" });
      }
    } catch (err) {
      addToast({ type: "error", message: "Refresh failed", description: err.message });
    } finally {
      setPulling(false);
    }
  }, [request, addToast, fetchStatus]);

  const handleRemove = useCallback(async () => {
    if (repoToRemove === null) return;
    setRemoving(true);
    try {
      const csrfRes = await api("/auth/csrf");
      const csrfData = await csrfRes.json();
      const res = await request(`/repos/${repoToRemove.index}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfData.csrf_token },
      });
      if (res.ok) {
        addToast({ type: "success", message: "App source removed", description: "Restart LibreServ to finish" });
        setRepoToRemove(null);
        fetchStatus();
      } else {
        const err = await res.json();
        addToast({ type: "error", message: "Remove failed", description: err.error || "Unknown error" });
      }
    } catch (err) {
      addToast({ type: "error", message: "Remove failed", description: err.message });
    } finally {
      setRemoving(false);
    }
  }, [request, addToast, fetchStatus, repoToRemove]);

  const formatLastPull = (dateStr) => {
    if (!dateStr || dateStr === "0001-01-01T00:00:00Z") return "Never";
    const date = /** @type {any} */ (new Date(dateStr));
    const now = /** @type {any} */ (new Date());
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <div data-slot="repo-status-card">
      <SettingsCard
        icon={Package}
        title="App Sources"
        padding={false}
        index={index}
      >
        <div className="px-5 py-4">
          <p className="text-sm text-primary mb-4">
            These are the places LibreServ looks for apps you can install.
          </p>

          <div className="flex items-center justify-between gap-4 mb-4 p-1.5 rounded-full bg-primary/10">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-primary/20 text-primary">
              {repos.length === 0 ? "No app sources yet" : `${repos.length} app source${repos.length !== 1 ? "s" : ""}`}
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={handlePull}
                disabled={pulling || repos.length === 0}
                size="sm"
              >
                {pulling ? (
                  <>
                    <Loader2 className="animate-spin" size={16} />
                    Refreshing...
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} />
                    Check for new apps
                  </>
                )}
              </Button>
              <Button
                variant="primary"
                onClick={() => setShowAddModal(true)}
                size="sm"
              >
                <Plus size={16} />
                Add a source
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={20} className="animate-spin text-primary/50" />
            </div>
          ) : fetchError ? (
            <div className="flex items-center justify-center py-6">
              <Button
                variant="ghost"
                surface="secondary"
                size="sm"
                onClick={fetchStatus}
                className="text-error hover:text-primary"
              >
                Could not load app sources. Click to retry.
              </Button>
            </div>
          ) : repos.length === 0 ? (
            <div className="text-center py-8 px-4">
              <Package size={32} className="mx-auto text-primary mb-3" />
              <p className="text-sm text-primary mb-1">No app sources yet</p>
              <p className="text-sm text-primary mb-4">
                Add a source to start discovering apps you can install.
              </p>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={16} />
                Add your first app source
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {repos.map((repo, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-large-element bg-primary/5 border border-primary/10"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {repo.last_error ? (
                        <AlertCircle size={14} className="text-error shrink-0" />
                      ) : (
                        <CheckCircle size={14} className="text-success shrink-0" />
                      )}
                      <span className="text-sm text-primary truncate">{repo.url}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-primary">
                      <span>Version: {repo.branch}</span>
                      <span>Last checked: {formatLastPull(repo.last_pull)}</span>
                    </div>
                    {repo.last_error && (
                      <p className="text-xs text-error mt-1.5">
                        This source could not be reached. Check the address or remove it.
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setRepoToRemove({ index: i, url: repo.url })}
                    aria-label="Remove app source"
                    className="hover:bg-error/10 hover:text-error"
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      {showAddModal && (
        <AddRepoModal
          onClose={() => setShowAddModal(false)}
          onAdded={fetchStatus}
        />
      )}

      <ConfirmModal
        open={repoToRemove !== null}
        onClose={() => setRepoToRemove(null)}
        onConfirm={handleRemove}
        icon={Trash2}
        title="Remove this app source?"
        message={`New apps from ${repoToRemove?.url ?? "this source"} will stop appearing. Apps you already installed will keep working.`}
        variant="danger-undoable"
        confirmLabel="Remove source"
        loading={removing}
      />
    </div>
  );
}
