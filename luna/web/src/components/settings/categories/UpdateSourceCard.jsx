import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Rss } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import ConnectDeviceCodeForm from "../ConnectDeviceCodeForm.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { getJson, putJson, apiErrorMessage } from "../../../lib/api";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const DEFAULT_FEED_PLACEHOLDER =
  "https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds";

const INPUT_CLASS =
  "w-full min-w-0 rounded-pill surface-primary px-4 py-2 font-mono";

/** Keys shown in the form: stored override, else the key Luna is actually using. */
function signingKeysForDisplay(source) {
  const s = source || {};
  const stored = s.keys || [];
  if (stored.length > 0) return stored;
  const effective = s.effective_keys || [];
  if (effective.length > 0) return effective;
  return s.defaults?.keys || [];
}

/** Keys sent on save — empty means “keep Luna’s built-in release key”. */
function signingKeysForSave(keyLines, source) {
  const defaults = source?.defaults?.keys || [];
  const trimmed = keyLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (trimmed.length === 0) return [];
  const defaultText = defaults.join("\n");
  if (trimmed.join("\n") === defaultText) return [];
  return trimmed;
}

const CHANNEL_OPTIONS = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
];

export default function UpdateSourceCard({ index = 3 }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const source = useQuery({
    queryKey: ["updates-source"],
    queryFn: () => getJson("/api/v1/system/updates/source"),
  });

  const s = source.data || {};
  const customized =
    source.data != null &&
    (!s.default_keys || (s.defaults && s.feed_url !== s.defaults.feed_url));

  const onSaved = (data) => {
    queryClient.setQueryData(["updates-source"], (old) => {
      const prev = /** @type {Record<string, unknown>} */ (old || {});
      return { ...prev, ...data };
    });
    queryClient.invalidateQueries({ queryKey: ["updates-source"] });
    queryClient.invalidateQueries({ queryKey: ["system-updates"] });
  };

  const changeChannel = useMutation({
    mutationFn: (/** @type {string} */ channel) =>
      putJson("/api/v1/system/updates/source", {
        feed_url: s.feed_url,
        channel,
        keys: signingKeysForSave(signingKeysForDisplay(s), s),
      }),
    onSuccess: (data) => {
      addToast({ type: "success", message: "Update channel saved." });
      onSaved(data);
    },
  });

  return (
    <SettingsCard icon={AlertTriangle} title="Advanced" padding={false} index={index}>
      <div className="px-5 py-4 space-y-4">
        <CollapsibleSection title="Luna Connect" mono pill>
          <div className="space-y-3 mb-1">
            <p className="text-sm text-primary leading-relaxed">
              Set or remove the Luna Connect device token here.
            </p>
            <Button
              type="button"
              variant="danger"
              surface="secondary"
              onClick={() => setConnectModalOpen(true)}
            >
              Change device token
            </Button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Update source" mono pill>
          <div className="space-y-4 mb-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-primary text-sm">
                Update channel{" "}
                <InfoHint
                  label="What the update channel is"
                  content="Stable gets releases once they are tested. Beta gets new versions sooner and may have bugs. You can switch back to Stable at any time; Luna never installs an older version."
                />
              </div>
              <SegmentedControl
                aria-label="Update channel"
                surface="secondary"
                value={s.channel || "stable"}
                options={CHANNEL_OPTIONS}
                onChange={(channel) => {
                  if (source.data && channel !== s.channel) changeChannel.mutate(channel);
                }}
              />
            </div>
            {changeChannel.isError && (
              <PageNotice variant="error">{apiErrorMessage(changeChannel.error)}</PageNotice>
            )}

            <CollapsibleSection title="Feed address and signing keys" size="xs" pill>
              <div className="p-4 mb-3 rounded-large-element bg-warning/20 border-2 border-warning/30">
                <div className="flex items-center gap-3">
                  <AlertTriangle size={ICON_SIZE.lg} className="text-warning flex-shrink-0" aria-hidden="true" />
                  <p className="text-sm text-primary font-semibold">
                    Only change these if your updates come from somewhere else.{" "}
                    <InfoHint
                      label="What these settings control"
                      content="They control where Luna itself gets its software updates — not your files, photos, or backups. A wrong value can stop Luna from updating, so leave these as-is unless you're pointing Luna at a different update source."
                    />
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <Pill variant={customized ? "warning" : "success"}>
                  {customized ? "Custom source" : "Default source"}
                </Pill>
                <InlinePill className="break-all">{s.feed_url || "…"}</InlinePill>
              </div>
              <Button
                type="button"
                variant="outline"
                surface="secondary"
                onClick={() => setModalOpen(true)}
              >
                <Rss size={ICON_SIZE.sm} aria-hidden="true" />
                Edit update source
              </Button>
            </CollapsibleSection>
          </div>
        </CollapsibleSection>
      </div>

      <ModalCard
        open={connectModalOpen}
        title="Device token"
        onClose={() => setConnectModalOpen(false)}
      >
        <ConnectDeviceCodeForm />
      </ModalCard>

      {source.data && (
        <UpdateSourceModal
          open={modalOpen}
          initial={source.data}
          onClose={() => setModalOpen(false)}
          onSaved={onSaved}
        />
      )}
    </SettingsCard>
  );
}

function UpdateSourceModal({ open = true, initial, onClose, onSaved }) {
  const { addToast } = useToast();
  const s = useMemo(() => initial || {}, [initial]);

  const [feedUrl, setFeedUrl] = useState(s.feed_url || "");
  const [keysText, setKeysText] = useState(signingKeysForDisplay(s).join("\n"));
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
    setFeedUrl(s.feed_url || "");
    setKeysText(signingKeysForDisplay(s).join("\n"));
    setSaveError(null);
  }, [open, s]);

  const keyLines = keysText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const defaults = s.defaults || {};
  const initialKeyLines = signingKeysForDisplay(s);
  const dirty =
    feedUrl !== (s.feed_url || "") || keyLines.join("\n") !== initialKeyLines.join("\n");

  const save = useMutation({
    mutationFn: () =>
      putJson("/api/v1/system/updates/source", {
        feed_url: feedUrl.trim(),
        channel: s.channel || "stable",
        keys: signingKeysForSave(keyLines, s),
      }),
    onSuccess: (data) => {
      addToast({ type: "success", message: "Update source saved." });
      onSaved(data);
      onClose();
    },
    onError: (err) => setSaveError(apiErrorMessage(err)),
  });

  const handleSave = () => {
    const trimmed = feedUrl.trim();
    if (!trimmed) {
      setSaveError("The feed address needs a value. Put in the old address if you want to keep it.");
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setSaveError("The feed address must start with http:// or https://.");
      return;
    }
    const badKey = keyLines.find(
      (line) => !line.startsWith("RW") && !line.startsWith("untrusted comment"),
    );
    if (badKey) {
      setSaveError(
        "One of those signing keys is not a valid minisign public key. Paste the key exactly as it appears in its .pub file (one line starting with RW).",
      );
      return;
    }
    setSaveError(null);
    save.mutate();
  };

  const restoreDefaults = () => {
    setFeedUrl(defaults.feed_url || "");
    setKeysText((defaults.keys || []).join("\n"));
    setSaveError(null);
  };

  const feedShake =
    saveError && (saveError.includes("feed address") || saveError.includes("http://"))
      ? saveError
      : null;
  const keysShake =
    saveError && saveError.includes("signing keys") ? saveError : null;
  const generalSaveShake = saveError && !feedShake && !keysShake ? saveError : null;

  return (
    <ModalCard open={open} title="Update source" onClose={onClose}>
      {({ close }) => (
        <div className="space-y-4">
          <p className="text-primary text-sm">
            Where Luna reads its list of updates — for the software on this Luna, not your files or
            backups.
          </p>

          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="us-feed-url">
              Feed address{" "}
              <InfoHint
                label="What the feed address is"
                content="The web address of the folder that holds Luna's update lists. Luna adds luna/ and your channel (stable or beta) to find the right list."
              />
            </label>
            <ShakeTarget shake={feedShake || generalSaveShake}>
              <input
                id="us-feed-url"
                type="text"
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                placeholder={defaults.feed_url || DEFAULT_FEED_PLACEHOLDER}
                className={INPUT_CLASS}
              />
            </ShakeTarget>
          </div>

          <div className="space-y-1">
            <label className="block text-sm text-primary translate-x-5" htmlFor="us-keys">
              Signing keys{" "}
              <InfoHint
                label="What signing keys do"
                content="Luna only installs an update whose signature matches one of these public keys. That is how it knows an update really comes from the project and wasn't changed on the way. The LibreLoom release key is already filled in — change it only if your updates are signed by someone else."
              />
            </label>
            <ShakeTarget shake={keysShake || generalSaveShake}>
              <textarea
                id="us-keys"
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
                rows={3}
                placeholder={(defaults.keys || []).join("\n") || "Luna's built-in release key"}
                className="w-full min-w-0 rounded-large-element surface-primary px-4 py-2 font-mono text-sm"
              />
            </ShakeTarget>
            <p className="text-primary text-sm">
              One{" "}
              <TermHint content="A minisign public key is one line of text, starting with RW, that lets Luna check a signature. It is safe to share.">
                signing key
              </TermHint>{" "}
              per line.
              {s.default_keys
                ? " This is the key Luna shipped with — leave it as-is unless your updates use a different signer."
                : " Clear the field and save to go back to Luna's built-in release key."}
            </p>
          </div>

          {saveError && <PageNotice variant="error">{saveError}</PageNotice>}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="primary"
              loading={save.isPending}
              disabled={!dirty}
              onClick={handleSave}
              className="flex-1"
            >
              {save.isPending ? null : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="outline"
              surface="secondary"
              onClick={restoreDefaults}
              disabled={save.isPending}
            >
              Use defaults
            </Button>
            <Button
              type="button"
              variant="outline"
              surface="secondary"
              onClick={close}
              disabled={save.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}
