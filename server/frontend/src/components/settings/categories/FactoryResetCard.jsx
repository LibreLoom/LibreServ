import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import PropTypes from "prop-types";

import ConfirmModal from "../../common/ConfirmModal";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";

/** @param {{ index?: number, settings?: any }} _ */
function FactoryResetCard({ index = 2 }) {
  const { request, logout } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  const handleFactoryReset = useCallback(async () => {
    if (!confirmText || confirmText !== "RESET" || !password) return;

    setLoading(true);
    try {
      await request("/admin/factory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, password }),
      });
      addToast({ type: "success", message: "Factory reset complete" });
      await logout();
      navigate("/setup");
    } catch (err) {
      addToast({ type: "error", message: err.message || "Factory reset failed" });
    } finally {
      setLoading(false);
    }
  }, [confirmText, password, request, addToast, logout, navigate]);

  return (
    <div data-slot="factory-reset-card">
      <SettingsCard icon={AlertTriangle} title="Factory Reset" index={index}>
        <p className="text-sm text-primary mb-4">
          Reset this device to factory defaults. <strong>This will delete all data and settings.</strong>
        </p>
        <Button
          variant="danger"
          onClick={() => setModalOpen(true)}
        >
          Factory Reset This Device
        </Button>
      </SettingsCard>

      <ConfirmModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setConfirmText("");
          setPassword("");
        }}
        onConfirm={handleFactoryReset}
        icon={AlertTriangle}
        title="Factory Reset This Device"
        variant="danger"
        confirmLabel={loading ? "Resetting..." : "Reset"}
        confirmIcon={loading ? Loader2 : undefined}
        loading={loading}
        disabledConfirm={confirmText !== "RESET" || !password}
        initialFocusRef={inputRef}
      >
        <div className="space-y-2 text-sm">
          <p>
            This will permanently delete ALL data on this LibreServ device, including:
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>All installed apps and their data</li>
            <li>All routes and SSL certificates</li>
            <li>All backups (local and cloud)</li>
            <li>All users and their settings</li>
            <li>All security events and audit logs</li>
            <li>All network and notification settings</li>
          </ul>
          <p className="font-semibold text-error">
            This action cannot be undone.
          </p>
        </div>

        <div className="mt-4">
          <label className="block font-mono text-xs text-accent mb-1">
            Type RESET to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Type RESET"
            className="w-full px-3 py-2 rounded-large-element bg-secondary border-2 border-accent/30 text-primary font-mono text-sm focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mt-3">
          <label className="block font-mono text-xs text-accent mb-1">
            Enter your password to confirm
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            className="w-full px-3 py-2 rounded-large-element bg-secondary border-2 border-accent/30 text-primary font-mono text-sm focus:border-accent focus:outline-none"
            autoComplete="off"
          />
        </div>
      </ConfirmModal>
    </div>
  );
}

FactoryResetCard.propTypes = {
  index: PropTypes.number,
};

export default FactoryResetCard;
