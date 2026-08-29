import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitBranch } from "lucide-react";
import Button from "../../ui/Button";
import CollapsibleSection from "../../common/CollapsibleSection";
import ModalCard from "../../cards/ModalCard";
import PageNotice from "../../common/PageNotice";
import Pill from "../../common/Pill";
import SettingsCard from "../SettingsCard";
import ConnectSetupCodeForm from "../ConnectSetupCodeForm.jsx";
import { InfoHint } from "../../ui/Tooltip";
import { getJson, putJson, apiErrorMessage } from "../../../lib/api";

const INPUT_CLASS =
  "w-full min-w-0 rounded-pill bg-primary text-secondary px-4 py-2 font-mono";

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

export default function UpdateSourceCard({ index = 3 }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const source = useQuery({
    queryKey: ["updates-source"],
    queryFn: () => getJson("/api/v1/system/updates/source"),
  });

  const s = source.data || {};
  const customized =
    source.data != null &&
    (!s.default_keys ||
      (s.defaults &&
        (s.api_base !== s.defaults.api_base ||
          s.owner !== s.defaults.owner ||
          s.repo !== s.defaults.repo)));

  return (
    <SettingsCard icon={AlertTriangle} title="Advanced" padding={false} index={index}>
      <div className="px-5 py-4 space-y-4">
        <CollapsibleSection title="Setup code" mono pill defaultOpen>
          <div className="space-y-3 mb-1">
            <p className="text-sm text-primary leading-relaxed">
              Enter the setup code from Luna Connect here, or during the installer. Purchased Lunas
              can also use the code that came with the device.
            </p>
            <ConnectSetupCodeForm compact />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Update source" mono pill>
          <div className="p-4 mb-3 rounded-large-element bg-warning/20 border-2 border-warning/30">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm text-primary space-y-1.5">
                <p className="font-semibold">Don&apos;t touch these during normal use.</p>
                <p>
                  These settings control where <strong>Luna itself</strong> gets its software
                  updates from. They have nothing to do with your files, photos, or backups.
                  Changing them without knowing what you&apos;re doing can stop Luna from updating.
                  Leave them alone unless you need to point Luna at a different update source.
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mb-3">
            <Pill variant={customized ? "warning" : "success"}>
              {customized ? "Custom source" : "Default source"}
            </Pill>
            <span className="text-primary text-sm font-mono break-all">
              {s.owner ? `${s.owner}/${s.repo}` : "…"}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            surface="secondary"
            onClick={() => setModalOpen(true)}
          >
            <GitBranch size={14} aria-hidden="true" />
            Edit update source
          </Button>
        </CollapsibleSection>
      </div>

      {source.data && (
        <UpdateSourceModal
          open={modalOpen}
          initial={source.data}
          onClose={() => setModalOpen(false)}
          onSaved={(data) => {
            queryClient.setQueryData(["updates-source"], (old) => {
              const prev = /** @type {Record<string, unknown>} */ (old || {});
              return { ...prev, ...data };
            });
            queryClient.invalidateQueries({ queryKey: ["updates-source"] });
            queryClient.invalidateQueries({ queryKey: ["system-updates"] });
          }}
        />
      )}
    </SettingsCard>
  );
}

function UpdateSourceModal({ open = true, initial, onClose, onSaved }) {
  const s = initial || {};

  const [baseUrl, setBaseUrl] = useState(s.api_base || "");
  const [owner, setOwner] = useState(s.owner || "");
  const [repo, setRepo] = useState(s.repo || "");
  const [keysText, setKeysText] = useState(signingKeysForDisplay(s).join("\n"));
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
    setBaseUrl(s.api_base || "");
    setOwner(s.owner || "");
    setRepo(s.repo || "");
    setKeysText(signingKeysForDisplay(s).join("\n"));
    setSaveError(null);
  }, [open, s.api_base, s.owner, s.repo, s.keys, s.effective_keys, s.default_keys, s.defaults]);

  const keyLines = keysText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const defaults = s.defaults || {};
  const initialKeyLines = signingKeysForDisplay(s);
  const dirty =
    baseUrl !== (s.api_base || "") ||
    owner !== (s.owner || "") ||
    repo !== (s.repo || "") ||
    keyLines.join("\n") !== initialKeyLines.join("\n");

  const save = useMutation({
    mutationFn: () =>
      putJson("/api/v1/system/updates/source", {
        api_base: baseUrl.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        keys: signingKeysForSave(keyLines, s),
      }),
    onSuccess: (data) => {
      onSaved(data);
      onClose();
    },
    onError: (err) => setSaveError(apiErrorMessage(err)),
  });

  const handleSave = () => {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      setSaveError("The API address needs a value. Put in the old address if you want to keep it.");
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setSaveError("The API address must start with http:// or https://.");
      return;
    }
    if (!owner.trim() || !repo.trim()) {
      setSaveError(
        "Both the owner and the repo need a value — they say which project page the updates come from.",
      );
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
    setBaseUrl(defaults.api_base || "");
    setOwner(defaults.owner || "");
    setRepo(defaults.repo || "");
    setKeysText((defaults.keys || []).join("\n"));
    setSaveError(null);
  };

  return (
    <ModalCard open={open} title="Update source" onClose={onClose}>
      {({ close }) => (
        <div className="space-y-4">
          <p className="text-primary text-sm">
            Where Luna gets its own updates from — the software running on this Luna, not your files
            or backups.
          </p>

          <div className="space-y-1">
            <label className="block text-sm text-primary" htmlFor="us-base-url">
              API address{" "}
              <InfoHint
                label="What the API address is"
                content="The web address of the code-hosting server (a Forgejo server) that publishes Luna updates — usually ending in /api/v1. If you host Luna's releases on your own server, put that server's address here. Example: https://gt.plainskill.net/api/v1"
              />
            </label>
            <input
              id="us-base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={defaults.api_base || "https://gt.plainskill.net/api/v1"}
              className={INPUT_CLASS}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-sm text-primary" htmlFor="us-owner">
                Owner
              </label>
              <input
                id="us-owner"
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder={defaults.owner || "LibreLoom"}
                className={INPUT_CLASS}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm text-primary" htmlFor="us-repo">
                Repo{" "}
                <InfoHint
                  label="What the repo is"
                  content="The project page on that server where the releases live. Together with the owner it points at one page, like LibreLoom/LibreServ."
                />
              </label>
              <input
                id="us-repo"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder={defaults.repo || "LibreServ"}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-sm text-primary" htmlFor="us-keys">
              Signing keys{" "}
              <InfoHint
                label="What signing keys do"
                content="An update is only installed when it carries a signature made with the matching secret key. These public keys are how Luna knows an update really comes from the project and wasn't tampered with. Luna already ships with the LibreLoom release key filled in below — you only need to change this if your updates are signed by someone else."
              />
            </label>
            <textarea
              id="us-keys"
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
              rows={3}
              placeholder={(defaults.keys || []).join("\n") || "Luna's built-in release key"}
              className="w-full min-w-0 rounded-large-element bg-primary text-secondary px-4 py-2 font-mono text-sm"
            />
            <p className="text-primary text-sm">
              One minisign public key per line (the line that starts with RW).
              {s.default_keys
                ? " This is the key Luna shipped with — leave it as-is unless you know your updates use a different signer."
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
