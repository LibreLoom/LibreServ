import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload } from "lucide-react";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { useOptionalAuth } from "../../context/AuthContext";
import RestoreForm from "./RestoreForm.jsx";
import { apiErrorMessage } from "../../lib/api";
import { getPhraseStatus, PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import { getRestoreStatus, restoreFromPhrase, RESTORE_QUERY_KEY } from "../../lib/cloudRestore";

/**
 * Shown to an Admin when Luna has lost its list of cloud backups. The browser opens
 * the recovery phrase's key copies and sends only the opened keys to Luna.
 * Renders nothing for anyone else, and while the status is loading or unreadable.
 */
export default function CloudRestoreCard() {
  const auth = useOptionalAuth();
  const user = auth?.user;
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const fieldRef = useRef(null);
  const restoreAbortRef = useRef(null);
  const [words, setWords] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);

  useEffect(() => () => restoreAbortRef.current?.abort(), []);

  const restore = useQuery({
    queryKey: RESTORE_QUERY_KEY,
    queryFn: getRestoreStatus,
    enabled: isAdmin,
  });
  const phrase = useQuery({
    queryKey: PHRASE_QUERY_KEY,
    queryFn: getPhraseStatus,
    enabled: isAdmin,
  });

  const restoreMutation = useMutation({
    mutationFn: (/** @type {string} */ text) => {
      const controller = new AbortController();
      restoreAbortRef.current = controller;
      return restoreFromPhrase(text, {
        lunaId: restore.data.luna_id,
        signingPublic: restore.data.signing_public,
        userId: String(user.id),
        phraseSet: Boolean(phrase.data?.set),
      }, setProgress, controller.signal);
    },
    onSuccess: ({ snapshots, alreadyIndexed, warning }) => {
      setError("");
      setProgress(null);
      setWords("");
      const found = snapshots + alreadyIndexed;
      addToast(warning
        ? {
          type: "warning",
          message: "Backup list restored with a warning",
          description: warning,
        }
        : {
          type: "success",
          message: found === 1 ? "Found 1 backup version" : `Found ${found} backup versions`,
        });
      // Keep the form available when ownership relinking failed. The server persists that
      // retry state separately from snapshot counts and clears it after a successful retry.
      if (warning) {
        queryClient.setQueryData(RESTORE_QUERY_KEY, (
          /** @type {unknown} */ current,
        ) => {
          if (!current || typeof current !== "object") return current;
          const status = /** @type {Record<string, unknown>} */ (current);
          const cloudSnapshots = status.cloud_snapshots;
          const indexedSnapshots = status.indexed_snapshots;
          if (typeof cloudSnapshots !== "number" || typeof indexedSnapshots !== "number") return current;
          return {
            ...status,
            needed: true,
            relink_pending: true,
            indexed_snapshots: Math.min(cloudSnapshots, indexedSnapshots + snapshots),
          };
        });
      } else {
        queryClient.invalidateQueries({ queryKey: RESTORE_QUERY_KEY });
      }
      queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      setWords("");
      setProgress(null);
      setError(err?.name === "AbortError"
        ? "Restore stopped. Some backup versions may already be back; you can safely try again."
        : apiErrorMessage(err, "Could not bring back your cloud backups. Try again."));
      queryClient.invalidateQueries({ queryKey: RESTORE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
      if (err?.name !== "AbortError") {
        // shakeElement fires the error haptic, so no separate haptic call here.
        shakeElement(fieldRef.current);
      }
    },
    onSettled: () => { restoreAbortRef.current = null; },
  });

  if (!isAdmin || restore.isPending || restore.isError
      || (!restore.data?.needed && !restore.data?.relink_pending)) return null;

  const submit = (e) => {
    e.preventDefault();
    if (!words.trim() || restoreMutation.isPending) return;
    setError("");
    restoreMutation.mutate(words);
  };

  const cloudCount = restore.data.cloud_snapshots;
  const indexedCount = restore.data.indexed_snapshots;

  if (!restore.data.signing_public) {
    return (
      <SettingsCard icon={CloudDownload} title="Bring back cloud backups">
        <PageNotice variant="warning">
          Luna hasn&apos;t found its backup signing key yet. Connect the drives that were in this Luna, then reload this page.
        </PageNotice>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard icon={CloudDownload} title="Bring back cloud backups">
      <div className="space-y-3">
        <p className="text-primary text-sm">
          {restore.data.relink_pending
            ? "Luna restored the backup list, but some backups are still linked to an old account. Enter your recovery phrase again to finish reconnecting them."
            : "Some cloud backup versions are missing from Luna's list. Enter your recovery phrase to find them again."}
        </p>
        <p className="text-primary text-sm">
          {cloudCount === 1 ? "1 version is" : `${cloudCount} versions are`} in the cloud.{" "}
          {indexedCount === 1 ? "Luna has 1 version" : `Luna has ${indexedCount} versions`} in its list.{" "}
          <InfoHint label="What a version is" content="One saved state of a backup, from one time it ran." />
        </p>

        <RestoreForm
          words={words}
          onWords={setWords}
          onSubmit={submit}
          error={error}
          pending={restoreMutation.isPending}
          progress={progress}
          onCancel={() => restoreAbortRef.current?.abort()}
          submitLabel="Find my backups"
          fieldRef={fieldRef}
        />
      </div>
    </SettingsCard>
  );
}
