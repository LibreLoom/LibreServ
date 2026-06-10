import { Shield } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button.jsx";

const TOOL_LABELS = {
  podman_restart: "restart an app",
  podman_stop: "stop an app",
  podman_start: "start an app",
  file_write: "change a file",
  snapshot_restore: "restore from a backup",
  file_read: "read a file",
  config_read: "read a setting",
  podman_ps: "list apps",
  podman_logs: "view app logs",
  podman_inspect: "check app details",
  podman_health: "check if an app is healthy",
  system_health: "check the server",
  file_list: "list files",
  snapshot_create: "create a backup",
  snapshot_list: "view backups",
};

function ChatPermissionPrompt({ toolName, reason, onAllow, onDeny }) {
  const friendlyName = TOOL_LABELS[toolName] || toolName.replace(/_/g, " ");

  return (
    <div className="bg-warning/10 border border-warning/20 rounded-large-element p-4">
      <div className="flex items-start gap-3">
        <Shield size={18} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 space-y-3">
          <div>
            <p className="text-sm font-mono text-primary mb-1">
              The assistant wants to {friendlyName}
            </p>
            <p className="text-xs text-primary/60">{reason}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={onAllow}>
              Allow this time
            </Button>
            <Button variant="ghost" size="sm" onClick={onDeny}>
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

ChatPermissionPrompt.propTypes = {
  toolName: PropTypes.string.isRequired,
  reason: PropTypes.string.isRequired,
  onAllow: PropTypes.func.isRequired,
  onDeny: PropTypes.func.isRequired,
};

export default ChatPermissionPrompt;
