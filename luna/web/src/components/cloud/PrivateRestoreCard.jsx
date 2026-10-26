import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload } from "lucide-react";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { useOptionalAuth } from "../../context/AuthContext";
import RestoreForm from "./RestoreForm.jsx";
import { apiErrorMessage } from "../../lib/api";
import {
  getPrivateRestoreStatus,
  PRIVATE_RESTORE_QUERY_KEY,
  restorePrivateFromPhrase,
} from "../../lib/privateRestore";

/**
 * Shown to any signed-in person when Luna has lost its list of private items. The browser
 * opens the items with the recovery phrase and sends Luna only the opened pieces.
 * Renders nothing while the status is loading or unreadable, and when nothing is missing.
 */
export default function PrivateRestoreCard() {
  const auth = useOptionalAuth();
  const user = auth?.user;
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const fieldRef = useRef(null);
  const [words, setWords] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);

  const status = useQuery({
    queryKey: PRIVATE_RESTORE_QUERY_KEY,
    queryFn: getPrivateRestoreStatus,
    enabled: Boolean(user),
  });

  const restoreMutation = useMutation({
    mutationFn: (/** @type {string} */ text) =>
      restorePrivateFromPhrase(text, {
        lunaId: status.data.luna_id,
        signingPublic: status.data.signing_public,
        onProgress: setProgress,
      }),
    onSuccess: ({ restored }) => {
      setError("");
      setProgress(null);
      setWords("");
      addToast({
        type: "success",
        message: restored === 1 ? "Found 1 private version" : `Found ${restored} private versions`,
      });
      queryClient.invalidateQueries({ queryKey: PRIVATE_RESTORE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["cloud-backups"] });
    },
    onError: (err) => {
      setWords("");
      setError(apiErrorMessage(err, "Could not bring back your private items. Try again."));
      // shakeElement fires the error haptic, so no separate haptic call here.
      shakeElement(fieldRef.current);
    },
  });

  if (!user || status.isPending) return null;

  if (status.isError) {
    return (
      <SettingsCard icon={CloudDownload} title="Bring back your private items">
        <PageNotice variant="warning">
          <div className="space-y-3">
            <p>Luna could not check whether your private items need restoring. Try again.</p>
            <Button
              variant="outline"
              surface="primary"
              size="sm"
              disabled={status.isFetching}
              onClick={() => status.refetch()}
            >
              Try again
            </Button>
          </div>
        </PageNotice>
      </SettingsCard>
    );
  }

  if (!status.data?.needed) return null;

  const submit = (e) => {
    e.preventDefault();
    if (!words.trim() || restoreMutation.isPending) return;
    setError("");
    setProgress(null);
    restoreMutation.mutate(words);
  };

  if (!status.data.signing_public) {
    return (
      <SettingsCard icon={CloudDownload} title="Bring back your private items">
        <PageNotice variant="warning">
          Luna hasn&apos;t found its backup signing key yet. Connect the drives that were in this Luna, then reload this page.
        </PageNotice>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard icon={CloudDownload} title="Bring back your private items">
      <div className="space-y-3">
        <p className="text-primary text-sm">
          Luna lost its list of your private items in the cloud. Enter your recovery phrase to find them again.
        </p>
        <p className="text-primary text-sm">
          Your phrase stays in this browser.{" "}
          <InfoHint
            label="Where your phrase goes"
            content="Your browser opens the list with your phrase and gives Luna only the file list. Luna never sees the phrase."
          />
        </p>

        <RestoreForm
          words={words}
          onWords={setWords}
          onSubmit={submit}
          error={error}
          pending={restoreMutation.isPending}
          progress={progress}
          submitLabel="Find my private items"
          fieldRef={fieldRef}
        />
      </div>
    </SettingsCard>
  );
}
