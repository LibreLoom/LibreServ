import { useState, useCallback } from "react";
import PropTypes from "prop-types";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { Globe, AlertTriangle, Loader2 } from "lucide-react";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ConfirmModal from "../../common/ConfirmModal";
import ValueDisplay from "../../common/ValueDisplay";
import Alert from "../../common/Alert";

export default function DomainManagementCard({ currentDomain, onDomainChange }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await request("/network/domain/disconnect", {
        method: "POST",
      });
      
      if (res.ok) {
        addToast({
          type: "warning",
          message: "Domain disconnected",
          description: "All routes have been cleared. You can reconnect a domain anytime.",
        });
        onDomainChange("");
        setShowDisconnectModal(false);
      } else {
        const data = await res.json();
        addToast({ type: "error", message: data.error || "Failed to disconnect domain" });
      }
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setDisconnecting(false);
    }
  }, [request, addToast, onDomainChange]);

  if (!currentDomain) {
    return (
      <SettingsCard icon={Globe} title="Domain Connection" index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-secondary/70 mb-4">
            No domain is currently connected. Connect a domain during setup or by going to Settings → Network.
          </p>
        </div>
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard icon={Globe} title="Connected Domain" index={1}>
        <div className="px-5 py-4 space-y-4">
          <div className="p-4 bg-secondary/5 rounded-card border border-secondary/10">
            <div className="text-sm text-primary/70 mb-1">Current Domain</div>
            <div className="text-2xl font-mono text-accent">{currentDomain}</div>
          </div>

          <div className="flex gap-3">
            <Button
              variant="accent"
              className="flex-1"
              onClick={() => window.location.href = "/setup?step=domain"}
            >
              Change Domain
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => setShowDisconnectModal(true)}
            >
              Disconnect
            </Button>
          </div>

          <div className="p-3 bg-warning/10 border border-warning/20 rounded-pill flex items-start gap-2">
            <AlertTriangle size={16} className="text-warning mt-0.5 flex-shrink-0" />
            <div className="text-xs text-warning">
              <strong>Warning:</strong> Disconnecting will remove all DNS records and clear your app routes. 
              Apps will still be accessible via localhost but not via their subdomains.
            </div>
          </div>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
        onConfirm={handleDisconnect}
        icon={AlertTriangle}
        title="Disconnect Domain"
        message={`Disconnect ${currentDomain}? This will:
          • Remove all DNS records
          • Clear all app routes
          • Apps will only be accessible via localhost`}
        variant="danger"
        confirmLabel="Disconnect"
        loading={disconnecting}
      />
    </>
  );
}
