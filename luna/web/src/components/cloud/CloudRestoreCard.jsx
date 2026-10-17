import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { useOptionalAuth } from "../../context/AuthContext";
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
  const [words, setWords] = useState("");
  const [error, setError] = useState("");

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
    mutationFn: (/** @type {string} */ text) =>
      restoreFromPhrase(text, {
        lunaId: restore.data.luna_id,
        signingPublic: restore.data.signing_public,
        userId: String(user.id),
        phraseSet: Boolean(phrase.data?.set),
      }),
    onSuccess: ({ snapshots }) => {
      setError("");
      setWords("");
      addToast({
        type: "success",
        message: snapshots === 1 ? "Found 1 backup version" : `Found ${snapshots} backup versions`,
      });
      queryClient.invalidateQueries({ queryKey: RESTORE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      setWords("");
      setError(apiErrorMessage(err, "Could not bring back your cloud backups. Try again."));
      // shakeElement fires the error haptic, so no separate haptic call here.
      shakeElement(fieldRef.current);
    },
  });

  if (!isAdmin || restore.isPending || restore.isError || !restore.data?.needed) return null;

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
          Luna lost its list of cloud backups. Enter your recovery phrase to find them again.
        </p>
        <p className="text-primary text-sm">
          {cloudCount === 1 ? "1 version is" : `${cloudCount} versions are`} in the cloud,{" "}
          {indexedCount === 1 ? "1 is" : `${indexedCount} are`} on Luna&apos;s list.{" "}
          <InfoHint label="What a version is" content="One saved state of a backup, from one time it ran." />
        </p>

        <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-primary text-sm">Recovery phrase</span>
            <textarea
              ref={fieldRef}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder="12 words, with spaces between them"
              rows={3}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-large-element bg-transparent border border-primary/30 p-3 text-primary text-sm outline-none focus:border-accent"
            />
          </label>
          <p className="text-primary text-sm">
            Only type your recovery phrase on this Luna or on <InlinePill>connect.luna.libreloom.org</InlinePill>.
          </p>
          {error && <PageNotice variant="error">{error}</PageNotice>}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={restoreMutation.isPending}
            disabled={restoreMutation.isPending || !words.trim()}
          >
            Find my backups
          </Button>
        </form>
      </div>
    </SettingsCard>
  );
}
