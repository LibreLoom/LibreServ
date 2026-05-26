import { Shield } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button.jsx";

function ChatPermissionPrompt({ toolName, reason, onAllow, onDeny }) {
  return (
    <div className="bg-warning/10 border border-warning/20 rounded-large-element p-4">
      <div className="flex items-start gap-3">
        <Shield size={18} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 space-y-3">
          <div>
            <p className="text-sm font-mono text-primary mb-1">
              The assistant needs your permission to: {toolName}
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
