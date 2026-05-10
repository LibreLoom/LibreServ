import { useState, useCallback, useEffect } from "react";
import { Database, RefreshCw, CheckCircle, AlertCircle, Loader2, Plus, Trash2, ExternalLink } from "lucide-react";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import api from "../../../lib/api";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ModalCard from "../../cards/ModalCard";

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
        throw new Error(err.error || "Failed to add repository");
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
    <ModalCard title="Add Repository" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <label className="text-sm text-primary/70 block mb-1">Repository URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/my-libreserv-apps"
            className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-secondary/60 focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
            disabled={adding}
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-primary/70 block mb-1">Branch</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
              disabled={adding}
            />
          </div>
          <div>
            <label className="text-sm text-primary/70 block mb-1">Priority</label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              min={1}
              className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
              disabled={adding}
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-error">{error}</p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={adding}
            className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!url.trim() || adding}
            className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {adding ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Adding...
              </>
            ) : (
              "Add Repository"
            )}
          </button>
        </div>
      </div>
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
        addToast({ type: "success", message: "Repositories pulled", description: "App catalog is up to date" });
        fetchStatus();
      } else {
        const err = await res.json();
        addToast({ type: "error", message: "Pull failed", description: err.error || "Unknown error" });
      }
    } catch (err) {
      addToast({ type: "error", message: "Pull failed", description: err.message });
    } finally {
      setPulling(false);
    }
  }, [request, addToast, fetchStatus]);

  const handleRemove = useCallback(async (indexToRemove) => {
    try {
      const csrfRes = await api("/auth/csrf");
      const csrfData = await csrfRes.json();
      const res = await request(`/repos/${indexToRemove}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfData.csrf_token },
      });
      if (res.ok) {
        addToast({ type: "success", message: "Repository removed", description: "Restart required to take effect" });
        fetchStatus();
      } else {
        const err = await res.json();
        addToast({ type: "error", message: "Remove failed", description: err.error || "Unknown error" });
      }
    } catch (err) {
      addToast({ type: "error", message: "Remove failed", description: err.message });
    }
  }, [request, addToast, fetchStatus]);

  const formatLastPull = (dateStr) => {
    if (!dateStr || dateStr === "0001-01-01T00:00:00Z") return "Never";
    const date = new Date(dateStr);
    const now = new Date();
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
    <>
      <SettingsCard
        icon={Database}
        title="App Repositories"
        padding={false}
        index={index}
      >
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-4 mb-4 p-1.5 rounded-full bg-primary/10">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-primary/20 text-primary">
              {repos.length === 0 ? "No repositories configured" : `${repos.length} repository${repos.length !== 1 ? "s" : ""} configured`}
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
                    Pulling...
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} />
                    Check Now
                  </>
                )}
              </Button>
              <Button
                variant="primary"
                onClick={() => setShowAddModal(true)}
                size="sm"
              >
                <Plus size={16} />
                Add
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={20} className="animate-spin text-primary/50" />
            </div>
          ) : fetchError ? (
            <div className="flex items-center justify-center py-6">
              <button
                onClick={fetchStatus}
                className="text-sm text-error hover:text-primary transition-colors"
              >
                Could not load repository status. Click to retry.
              </button>
            </div>
          ) : repos.length === 0 ? (
            <div className="text-sm text-primary/50 text-center py-6">
              Add a repository to receive app updates and security notices.
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
                    <div className="flex items-center gap-3 mt-1 text-xs text-primary/50">
                      <span className="flex items-center gap-1">
                        <ExternalLink size={10} />
                        {repo.branch}
                      </span>
                      <span>Priority: {repo.priority}</span>
                      <span>Last checked: {formatLastPull(repo.last_pull)}</span>
                      {repo.last_error && (
                        <span className="text-error">{repo.last_error}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(i)}
                    className="p-2 rounded-pill text-primary/40 hover:text-error hover:bg-error/10 transition-colors"
                    aria-label="Remove repository"
                  >
                    <Trash2 size={16} />
                  </button>
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
    </>
  );
}
