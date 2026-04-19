import { useState, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
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

  useEffect(() => {
    checkForUpdates(false, false);
  }, [checkForUpdates]);

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

  // Preprocess release notes to improve formatting
  const formatReleaseNotes = (notes) => {
    if (!notes) return "No changelog available.";
    
    // Common section headers that should be headings
    const commonHeaders = [
      "what's changed", "new features", "bug fixes", 
      "breaking changes", "upgrade notes", "commits since",
      "changelog", "release notes", "changes", "features",
      "fixes", "improvements", "security", "performance"
    ];
    
    // Split into lines and process
    const lines = notes.split('\n');
    const processedLines = lines.map((line, idx) => {
      const trimmed = line.trim();
      
      // Detect likely headings
      const lowerTrimmed = trimmed.toLowerCase();
      const isCommonHeader = commonHeaders.some(h => lowerTrimmed.includes(h));
      const isShortTitle = trimmed.length > 0 && 
                           trimmed.length < 80 && 
                           trimmed.split(' ').length <= 6 &&
                           /^[A-Z][A-Za-z0-9\s!-]*$/.test(trimmed);
      
      // First line is often the title
      const isFirstLine = idx === 0;
      
      const isHeading = isCommonHeader || 
                       (isShortTitle && trimmed.split(' ').length <= 5) ||
                       isFirstLine;
      
      // Add markdown heading syntax for detected headings
      if (isHeading) {
        return `## ${trimmed}`;
      }
      
      return trimmed;
    });
    
    return processedLines.join('\n');
  };

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
                {updateInfo.latest_version} available
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
              <div className="p-4 bg-primary rounded-large-element">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium text-secondary">What's New in</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-secondary text-primary">
                    {updateInfo.latest_version}
                  </span>
                </div>
                <div className="text-sm text-secondary leading-relaxed">
                  <ReactMarkdown
                    components={{
                      h1: (props) => (
                        <h1 className="text-lg font-bold text-secondary mt-4 mb-2" {...props} />
                      ),
                      h2: (props) => (
                        <h2 className="text-base font-bold text-secondary mt-3 mb-1.5" {...props} />
                      ),
                      h3: (props) => (
                        <h3 className="text-sm font-semibold text-secondary mt-2 mb-1" {...props} />
                      ),
                      p: (props) => <p className="mb-2 text-secondary/90" {...props} />,
                      ul: (props) => (
                        <ul className="list-disc list-inside mb-2 ml-2" {...props} />
                      ),
                      ol: (props) => (
                        <ul className="list-decimal list-inside mb-2 ml-2" {...props} />
                      ),
                      li: (props) => <li className="mb-0.5 text-secondary/90" {...props} />,
                      code: ({ inline, ...props }) =>
                        inline ? (
                          <code
                            className="bg-secondary/10 px-1 py-0.5 rounded text-xs font-mono text-secondary"
                            {...props}
                          />
                        ) : (
                          <pre className="bg-secondary/10 p-2 rounded mb-2 overflow-x-auto">
                            <code className="text-xs font-mono text-secondary block" {...props} />
                          </pre>
                        ),
                      blockquote: (props) => (
                        <blockquote
                          className="border-l-2 border-secondary/30 pl-3 italic text-secondary/70 mb-2"
                          {...props}
                        />
                      ),
                      hr: (props) => (
                        <hr className="my-3 border-secondary/30" {...props} />
                      ),
                      a: (props) => (
                        <a
                          className="text-secondary/90 underline hover:no-underline"
                          {...props}
                        />
                      ),
                      strong: (props) => (
                        <strong className="font-semibold text-secondary" {...props} />
                      ),
                      em: (props) => (
                        <em className="italic text-secondary/90" {...props} />
                      ),
                    }}
                  >
                    {formatReleaseNotes(updateInfo.release_notes)}
                  </ReactMarkdown>
                </div>
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
