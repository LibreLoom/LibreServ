import { useState } from "react";
import { Database, Check, Plus, Trash2 } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";

export default function BackupServiceModal({ open, onClose, service, repos }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );

  if (!open) return null;

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : "Disabled";

  return (
    <ModalCard title="Cloud Backup Storage" onClose={onClose} size="lg">
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Database size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              Your backups need a place to live. You can use multiple destinations —
              Connect storage alongside your own S3, B2, or SFTP endpoints.
            </p>
          </div>
        </div>

        <div className="bg-primary/5 rounded-pill p-4">
          <p className="text-sm text-primary flex items-center gap-2">
            <Check size={16} className="text-accent" />
            Connect backup storage available on your plan
          </p>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect for backups"
          description={
            useConnect
              ? "Your backups will be stored on Connect's S3-compatible storage."
              : "Configure your own backup destinations below."
          }
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-primary font-medium">
              Backup Destinations
            </span>
            <Button variant="accent" size="sm">
              <Plus size={14} /> Add Destination
            </Button>
          </div>

          {useConnect && (
            <div className="flex items-center gap-3 p-3 rounded-large-element bg-primary border-2 border-accent/20">
              <Check size={16} className="text-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-secondary font-medium">Connect Storage</p>
                <p className="text-xs text-accent">S3-compatible</p>
              </div>
              <span className="text-xs px-2.5 py-1 rounded-pill bg-accent text-primary font-medium">
                Connect
              </span>
            </div>
          )}

          {repos && repos.length > 0 ? (
            repos.map((repo, i) => (
              <div
                key={repo.id || i}
                className="flex items-center gap-3 p-3 rounded-large-element bg-primary border-2 border-secondary/10"
              >
                <Database size={16} className="text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-secondary">{repo.name || repo.repo_type}</p>
                  <p className="text-xs text-accent font-mono truncate">{repo.repo_path}</p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-pill bg-primary/20 text-accent font-medium capitalize">
                  {repo.repo_type}
                </span>
                <button className="text-accent hover:text-secondary motion-safe:transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          ) : (
            <p className="text-xs text-accent py-2">
              No custom backup destinations configured yet.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="accent" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onClose}>
            Save
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}
