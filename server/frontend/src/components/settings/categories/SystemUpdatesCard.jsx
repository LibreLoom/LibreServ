import { useState, useCallback, useEffect } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { Download, CheckCircle, AlertCircle, Loader2, RefreshCw, Info } from "lucide-react";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ConfirmModal from "../../common/ConfirmModal";

export default function SystemUpdatesCard({ index = 0 }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [updateInfo, setUpdateInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    checkForUpdates(false, false);
  }, []);

  const showSuccess = useCallback((message, description) => {
    addToast({ type: "success", message, description });
  }, [addToast]);

  const showError = useCallback((message, description) => {
    addToast({ type: "error", message, description });
  }, [addToast]);

  const checkForUpdates = useCallback(async (forceRefresh = false, showToast = true) => {
    setChecking(true);
    setError(null);
    try {
      const res = await request(`/system/updates/check${forceRefresh ? "?force=true" : ""}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to check for updates");
      }
      const data = await res.json();
      setUpdateInfo(data);
      
      if (showToast) {
        if (data.update_available) {
          showSuccess("Update available", `Version ${data.latest_version} is available`);
        } else {
          showSuccess("Up to date", "You're running the latest version");
        }
      }
    } catch (err) {
      setError(err.message);
      if (showToast) {
        showError("Check failed", err.message);
      }
    } finally {
      setChecking(false);
    }
  }, [request, showSuccess, showError]);

  const handleApplyUpdate = useCallback(async () => {
    setUpdating(true);
    try {
      const res = await request("/system/updates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to apply update");
      }
      
      setShowUpdateModal(false);
      showSuccess(
        "Update applied",
        "System is restarting. You will need to log in again."
      );
      
      setTimeout(() => {
        window.location.href = "/login?reason=update";
      }, 3000);
    } catch (err) {
      showError("Update failed", err.message);
    } finally {
      setUpdating(false);
    }
  }, [request, showSuccess, showError]);

  const getVersionDisplay = () => {
    if (!updateInfo) return "Unknown";
    return updateInfo.current_version || "Unknown";
  };

  const hasUpdate = updateInfo?.update_available;
  const isUpToDate = updateInfo && !hasUpdate;
  const notChecked = !updateInfo;

  return (
    <>
      <SettingsCard
        icon={Download}
        title="System Updates"
        padding={false}
        index={index}
      >
        <div className="p-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <div className="text-sm text-primary/70 mb-1">Current Version</div>
              <div className="text-lg font-mono font-semibold text-primary">
                {getVersionDisplay()}
              </div>
            </div>
            <Button
              variant="primary"
              onClick={() => checkForUpdates(true, true)}
              disabled={checking || updating}
              className="min-w-[160px]"
            >
              {checking ? (
                <>
                  <Loader2 className="animate-spin" size={16} />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw size={16} />
                  Check for Updates
                </>
              )}
            </Button>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="text-sm text-primary/70">Status:</div>
            {notChecked && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-primary text-secondary">
                <Info size={12} />
                Not checked
              </span>
            )}
            {isUpToDate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-success text-primary">
                <CheckCircle size={12} />
                Up to date
              </span>
            )}
            {hasUpdate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-warning text-primary">
                <AlertCircle size={12} />
                v{updateInfo.latest_version} available
              </span>
            )}
          </div>

          {error && (
            <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-error flex-shrink-0 mt-0.5" />
                <span className="text-sm text-error">{error}</span>
              </div>
            </div>
          )}

          {hasUpdate && (
            <div className="space-y-3">
              <div className="p-4 bg-primary rounded-lg border border-primary/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium text-secondary">What's New in</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-secondary text-primary">
                    v{updateInfo.latest_version}
                  </span>
                </div>
                <p className="text-sm text-secondary leading-relaxed">
                  {updateInfo.changelog || "No changelog available."}
                </p>
              </div>

              <Button
                variant="primary"
                onClick={() => setShowUpdateModal(true)}
                disabled={updating}
                className="w-full"
              >
                {updating ? (
                  <>
                    <Loader2 className="animate-spin" size={16} />
                    Updating...
                  </>
                ) : (
                  <>
                    <Download size={16} />
                    Update Now
                  </>
                )}
              </Button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex flex-wrap gap-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-primary/20 text-primary">
                <Info size={12} />
                Auto-restart after update
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-primary/20 text-primary">
                <CheckCircle size={12} />
                Re-login required
              </div>
            </div>
          </div>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleApplyUpdate}
        icon={Download}
        title="Apply Update"
        message={
          updateInfo
            ? `Update to version ${updateInfo.latest_version} will download and install. The system will restart automatically.`
            : "Apply update?"
        }
        variant="warning"
        confirmLabel="Update"
        confirmIcon={Download}
        loading={updating}
      />
    </>
  );
}
