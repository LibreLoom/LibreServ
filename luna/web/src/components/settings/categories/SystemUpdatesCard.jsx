import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Info,
  ExternalLink,
} from "lucide-react";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/** How often to ask Luna whether it is back after the restart. */
const HEALTH_POLL_MS = 2000;
/** Luna answers /health once it is up. If it never looked down (the restart was quick), reload after this long. */
const HEALTH_GIVE_UP_DOWN_MS = 20_000;

/**
 * Waits for Luna to restart: reloads the page once /health answers again after a gap.
 * @param {boolean} active
 */
function useReloadWhenLunaIsBack(active) {
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let sawDown = false;
    const startedAt = Date.now();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    async function poll() {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (res.ok && (sawDown || Date.now() - startedAt > HEALTH_GIVE_UP_DOWN_MS)) {
          if (!cancelled) window.location.reload();
          return;
        }
        if (!res.ok) sawDown = true;
      } catch {
        sawDown = true;
      }
      if (!cancelled) timer = setTimeout(poll, HEALTH_POLL_MS);
    }
    timer = setTimeout(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);
}

export default function SystemUpdatesCard({ index = 0 }) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showReleaseNotesModal, setShowReleaseNotesModal] = useState(false);
  const [checkMessage, setCheckMessage] = useState(null);
  const [retrying, setRetrying] = useState(false);
  // "installing" while lunad downloads and installs; "restarting" once it has answered and is going down.
  const [phase, setPhase] = useState(/** @type {null | "installing" | "restarting"} */ (null));
  useReloadWhenLunaIsBack(phase === "restarting");

  const updates = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => getJson("/api/v1/system/updates"),
    refetchInterval: 60 * 60 * 1000,
  });

  const check = useMutation({
    mutationFn: () => getJson("/api/v1/system/updates?force=true"),
    onSuccess: (data) => {
      queryClient.setQueryData(["system-updates"], data);
      addToast({
        type: data.update_available ? "success" : "info",
        message: data.update_available
          ? `Version ${data.latest_version} is ready to install.`
          : "You're running the latest Luna software.",
      });
    },
    onError: (err) => {
      setCheckMessage(apiErrorMessage(err));
    },
  });

  const afterInstall = () => {
    // Luna restarts a moment after answering. Keep the status up and reload once it is back.
    setPhase("restarting");
  };

  const installFailed = (err) => {
    setPhase(null);
    queryClient.invalidateQueries({ queryKey: ["system-updates"] });
    addToast({
      type: "error",
      message: "Luna couldn't install the update.",
      description: apiErrorMessage(err),
    });
  };

  const apply = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/apply", {}),
    onMutate: () => {
      setShowUpdateModal(false);
      setPhase("installing");
    },
    onSuccess: afterInstall,
    onError: installFailed,
  });

  // Forget the failed system update so it is offered again, then install it.
  const retry = useMutation({
    mutationFn: async () => {
      await postJson("/api/v1/system/updates/os-failed/clear", {});
      return postJson("/api/v1/system/updates/apply", {});
    },
    onMutate: () => {
      setShowUpdateModal(false);
      setRetrying(false);
      setPhase("installing");
    },
    onSuccess: afterInstall,
    onError: installFailed,
  });

  // Dismiss the warning about the failed system update without installing anything.
  const dismissFailed = useMutation({
    mutationFn: () => postJson("/api/v1/system/updates/os-failed/clear", {}),
    onSuccess: () => {
      queryClient.setQueryData(["system-updates"], (/** @type {any} */ old) =>
        old ? { ...old, os_update_failed: null } : old,
      );
      queryClient.invalidateQueries({ queryKey: ["system-updates"] });
      addToast({ type: "success", message: "Warning dismissed." });
    },
    onError: (err) => {
      addToast({
        type: "error",
        message: "Luna couldn't dismiss the warning.",
        description: apiErrorMessage(err),
      });
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
  const serverInstalling = Boolean(updateInfo?.applying);
  const updating = phase != null || apply.isPending || retry.isPending || serverInstalling;
  const failedUpdate = updateInfo?.os_update_failed;

  const getVersionDisplay = () => {
    if (!updateInfo) return "…";
    return updateInfo.current_version || "Unknown";
  };

  const hasUpdate = updateInfo?.update_available;
  const isUpToDate = updateInfo && !hasUpdate;
  const notChecked = !updateInfo && !updates.isLoading;

  return (
    <div data-slot="system-updates-card">
      <SettingsCard icon={Download} title="System updates" padding={false} index={index}>
        <div className="px-5 py-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <div className="text-sm mb-1">Current version</div>
              <div className="text-lg font-mono text-primary">
                {getVersionDisplay()}
              </div>
            </div>
            <Button
              variant="primary"
              onClick={checkForUpdates}
              disabled={updating}
              loading={checking}
              className="min-w-[160px]"
            >
              {checking ? (
                "Checking…"
              ) : (
                <>
                  <RefreshCw size={ICON_SIZE.md} aria-hidden="true" />
                  Check for updates
                </>
              )}
            </Button>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="text-sm">Status:</div>
            {notChecked && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-chip text-xs font-medium surface-primary">
                <Info size={ICON_SIZE.xs} aria-hidden="true" />
                Not checked yet
              </span>
            )}
            {isUpToDate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-chip text-xs font-medium bg-success/20 border-2 border-success/30 text-primary">
                <CheckCircle size={ICON_SIZE.xs} aria-hidden="true" />
                Up to date
              </span>
            )}
            {hasUpdate && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-chip text-xs font-medium bg-warning/20 border-2 border-warning/30 text-primary">
                <AlertCircle size={ICON_SIZE.xs} aria-hidden="true" />
                {updateInfo.latest_version} available
              </span>
            )}
          </div>

          {failedUpdate && (
            <PageNotice variant="warning" className="mb-4">
              <div className="space-y-3">
                <p>
                  The last system update didn&apos;t start, so Luna went back to the previous
                  version.
                  {failedUpdate.version && (
                    <>
                      {" "}
                      Version <InlinePill>{failedUpdate.version}</InlinePill> wasn&apos;t installed.
                    </>
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    surface="primary"
                    onClick={() => {
                      setRetrying(true);
                      setShowUpdateModal(true);
                    }}
                    disabled={updating}
                  >
                    Try again
                  </Button>
                  <InfoHint
                    surface="primary"
                    label="More about trying again"
                    content="Installs the same update again and restarts Luna."
                  />
                  <Button
                    variant="outline"
                    surface="primary"
                    onClick={() => dismissFailed.mutate()}
                    loading={dismissFailed.isPending}
                    disabled={updating}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </PageNotice>
          )}

          {checkMessage && !error && (
            <p className="mb-4 text-sm" role="status">
              {checkMessage}
            </p>
          )}

          {error && (
            <div className="mb-4 p-3 bg-error/20 border-2 border-error/30 rounded-large-element">
              <div className="flex items-start gap-2">
                <AlertCircle size={ICON_SIZE.md} className="text-error flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-sm text-error">{error}</span>
              </div>
            </div>
          )}

          {updating && (
              <div
                role="status"
                data-slot="update-installing"
                className="mb-4 flex items-center gap-3 rounded-large-element surface-primary p-4"
              >
                <Spinner decorative size="md" className="shrink-0" />
                <p className="text-sm">
                  {phase != null
                    ? "Installing the update. Luna will restart in a moment."
                    : "Installing update…"}
                </p>
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
                <ExternalLink size={ICON_SIZE.md} aria-hidden="true" />
                See what&apos;s new in {updateInfo.latest_version}
              </Button>

              {!updating && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setRetrying(false);
                    setShowUpdateModal(true);
                  }}
                  fullWidth
                >
                  <Download size={ICON_SIZE.md} aria-hidden="true" />
                  Update now
                </Button>
              )}

              <div className="flex flex-wrap gap-2">
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs surface-primary">
                  <Info size={ICON_SIZE.xs} aria-hidden="true" />
                  Luna restarts after an update
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs surface-primary">
                  <CheckCircle size={ICON_SIZE.xs} aria-hidden="true" />
                  Your files stay put
                </div>
              </div>
            </div>
          )}

          <p className="mt-4 text-sm">
            Luna only installs updates when you tell it to. No automatic or forced updates here.
          </p>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showUpdateModal}
        onClose={() => {
          setShowUpdateModal(false);
          setRetrying(false);
        }}
        onConfirm={() => (retrying ? retry.mutate() : apply.mutate())}
        icon={Download}
        title={retrying ? "Try the update again" : "Install update"}
        message={
          retrying
            ? "Luna will install the update again and restart. Your files stay put."
            : updateInfo
            ? `Luna will download version ${updateInfo.latest_version}, install it, and restart. Your files stay put.`
            : "Install the available update?"
        }
        variant="warning"
        confirmLabel={retrying ? "Try again" : "Update"}
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
              <div className="surface-primary rounded-large-element px-5 py-3">
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
