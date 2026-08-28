import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Info,
  ExternalLink,
} from "lucide-react";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ConfirmModal from "../../cards/ConfirmModal";
import ModalCard from "../../cards/ModalCard";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";

export default function SystemUpdatesCard({ index = 0 }) {
  const queryClient = useQueryClient();
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showReleaseNotesModal, setShowReleaseNotesModal] = useState(false);
  const [checkMessage, setCheckMessage] = useState(null);

  const updates = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => getJson("/api/v1/system/updates"),
  });

  const check = useMutation({
    mutationFn: () => getJson("/api/v1/system/updates?force=true"),
    onSuccess: (data) => {
      queryClient.setQueryData(["system-updates"], data);
      setCheckMessage(
        data.update_available
          ? `Version ${data.latest_version} is ready to install.`
          : "You're running the latest Luna software.",
      );
    },
    onError: (err) => {
      setCheckMessage(apiErrorMessage(err));
    },
  });

  const apply = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/apply", {}),
    onSuccess: () => {
      setShowUpdateModal(false);
      setTimeout(() => {
        window.location.href = "/login?reason=update";
      }, 3000);
    },
  });

  const checkForUpdates = () => {
    setCheckMessage(null);
    check.mutate();
  };

  const updateInfo = updates.data;
  const error = updates.isError
    ? apiErrorMessage(updates.error)
    : check.isError
      ? apiErrorMessage(check.error)
      : null;
  const checking = check.isPending || (updates.isLoading && !updateInfo);
  const updating = apply.isPending;

  const getVersionDisplay = () => {
    if (!updateInfo) return "…";
    return updateInfo.current_version || "Unknown";
  };

  const hasUpdate = updateInfo?.update_available;
  const isUpToDate = updateInfo && !hasUpdate;
  const notChecked = !updateInfo && !updates.isLoading;

  return (
    <div data-slot="system-updates-card">
      <SettingsCard icon={Download} title="System Updates" padding={false} index={index}>
        <div className="px-5 py-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <div className="text-sm text-accent mb-1">Current version</div>
              <div className="text-lg font-mono font-semibold text-primary">
                {getVersionDisplay()}
              </div>
            </div>
            <Button
              variant="primary"
              onClick={checkForUpdates}
              disabled={checking || updating}
              className="min-w-[160px]"
            >
              {checking ? (
                <>
                  <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                  Checking…
                </>
              ) : (
                <>
                  <RefreshCw size={16} aria-hidden="true" />
                  Check for updates
                </>
              )}
            </Button>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="text-sm text-accent">Status:</div>
            {notChecked && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs font-medium bg-primary text-secondary">
                <Info size={12} aria-hidden="true" />
                Not checked yet
              </span>
            )}
            {isUpToDate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs font-medium bg-success/20 border-2 border-success/30 text-primary">
                <CheckCircle size={12} aria-hidden="true" />
                Up to date
              </span>
            )}
            {hasUpdate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs font-medium bg-warning/20 border-2 border-warning/30 text-primary">
                <AlertCircle size={12} aria-hidden="true" />
                {updateInfo.latest_version} available
              </span>
            )}
          </div>

          {checkMessage && !error && (
            <p className="mb-4 text-sm text-accent" role="status">
              {checkMessage}
            </p>
          )}

          {error && (
            <div className="mb-4 p-3 bg-error/20 border-2 border-error/30 rounded-large-element">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-error flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-sm text-error">{error}</span>
              </div>
            </div>
          )}

          {hasUpdate && (
            <div className="space-y-3">
              <Button
                variant="primary"
                onClick={() => setShowReleaseNotesModal(true)}
                fullWidth
                className="justify-center font-sans"
              >
                <ExternalLink size={16} aria-hidden="true" />
                See what&apos;s new in {updateInfo.latest_version}
              </Button>

              <Button
                variant="primary"
                onClick={() => setShowUpdateModal(true)}
                disabled={updating}
                fullWidth
              >
                {updating ? (
                  <>
                    <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                    Updating…
                  </>
                ) : (
                  <>
                    <Download size={16} aria-hidden="true" />
                    Update now
                  </>
                )}
              </Button>

              <div className="flex flex-wrap gap-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs bg-accent/20 text-primary">
                  <Info size={12} aria-hidden="true" />
                  Luna restarts after an update
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs bg-accent/20 text-primary">
                  <CheckCircle size={12} aria-hidden="true" />
                  Sign in again afterward
                </div>
              </div>
            </div>
          )}

          <p className="mt-4 text-sm text-accent">
            Updates only install when you tap the button — Luna never installs them on its own.
          </p>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={() => apply.mutate()}
        icon={Download}
        title="Install update"
        message={
          updateInfo
            ? `Luna will download version ${updateInfo.latest_version}, install it, and restart. Your files stay put — you'll just need to sign in again.`
            : "Install the available update?"
        }
        variant="warning"
        confirmLabel="Update"
        confirmIcon={Download}
        loading={updating}
      />

      {showReleaseNotesModal && (
        <ModalCard
          title={`What's new in ${updateInfo?.latest_version}`}
          onClose={() => setShowReleaseNotesModal(false)}
          size="lg"
        >
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="overflow-y-auto flex-1 px-1">
              <div className="bg-primary text-secondary rounded-large-element px-5 py-3">
                <ReactMarkdown
                  rehypePlugins={[rehypeSanitize]}
                  components={{
                    h1: (props) => (
                      <h1
                        className="text-3xl font-mono font-normal mb-3 mt-0 first:mt-0 text-secondary"
                        {...props}
                      />
                    ),
                    h2: (props) => (
                      <h2
                        className="text-2xl font-mono font-normal mb-3 mt-3 first:mt-0 text-secondary"
                        {...props}
                      />
                    ),
                    h3: (props) => (
                      <h3
                        className="text-xl font-mono font-normal mb-2 mt-2 first:mt-0 text-secondary"
                        {...props}
                      />
                    ),
                    p: (props) => <p className="mb-3 last:mb-0 text-secondary" {...props} />,
                    ul: (props) => (
                      <ul className="list-disc list-inside mb-3 ml-4 last:mb-0" {...props} />
                    ),
                    ol: (props) => (
                      <ol className="list-decimal list-inside mb-3 ml-4 last:mb-0" {...props} />
                    ),
                    li: (props) => <li className="mb-1 text-secondary" {...props} />,
                    a: (props) => <a className="link-accent-card" {...props} />,
                  }}
                >
                  {updateInfo?.release_notes || "No release notes for this version."}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </ModalCard>
      )}
    </div>
  );
}
