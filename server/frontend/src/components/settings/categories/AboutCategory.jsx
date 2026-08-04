import { useState, useEffect } from "react";
import { Heart, Coffee, AlertTriangle, GitBranch } from "lucide-react";
import PropTypes from "prop-types";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import CollapsibleSection from "../../common/CollapsibleSection";
import ModalCard from "../../cards/ModalCard";

const inputClass =
  "w-full px-3 py-2 text-sm font-mono rounded-pill bg-primary/10 border-2 border-primary/20 text-primary focus-visible:ring-2 focus-visible:ring-accent no-focus-outline";

export default function AboutCategory({ settings, onUpdateSourceSave }) {
  const updates = settings?.updates;
  const [modalOpen, setModalOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Keep local draft in sync with saved settings (they load asynchronously).
  useEffect(() => {
    setBaseUrl(updates?.base_url || "");
    setOwner(updates?.owner || "");
    setRepo(updates?.repo || "");
  }, [updates?.base_url, updates?.owner, updates?.repo]);

  const current = updates || {};
  const dirty =
    baseUrl !== (current.base_url || "") ||
    owner !== (current.owner || "") ||
    repo !== (current.repo || "");

  const handleSave = async () => {
    const trimmed = { base_url: baseUrl.trim(), owner: owner.trim(), repo: repo.trim() };
    if (trimmed.base_url && !/^https?:\/\//i.test(trimmed.base_url)) {
      setSaveError("The API Base URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onUpdateSourceSave(trimmed);
      setModalOpen(false);
    } catch (err) {
      setSaveError(err.message || "Couldn't save the update source. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-slot="about-category">
      <SettingsCard icon={Heart} title="LibreServ" padding={false} index={0}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            LibreServ is a self-hosted application management platform that
            allows you to easily deploy and manage self-hosted applications.
          </p>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={14} className="text-error" />
              <span>Made with love for the open source community</span>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard icon={Coffee} title="Support LibreServ" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            LibreServ is free and open source. If it has made running your own
            server a little easier, you can help keep it going with a small
            contribution — entirely optional, always appreciated.
          </p>
          <div className="mt-4">
            <Button asChild variant="primary">
              <a
                href="https://ko-fi.com/libreloom"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Coffee size={16} aria-hidden="true" />
                Support us on Ko-fi
              </a>
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* Advanced — only rendered for admins, whose settings actually loaded. */}
      {updates != null && (
        <SettingsCard
          icon={AlertTriangle}
          title="Advanced"
          padding={false}
          index={2}
        >
          <div className="px-5 py-4 space-y-4">
            <CollapsibleSection
              title="Update Source"
              mono
              size="sm"
              pill
              className="mb-1"
            >
              <div className="p-4 mb-3 rounded-large-element bg-warning/20 border-2 border-warning/30">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={18} className="text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="text-sm text-primary space-y-1.5">
                    <p className="font-semibold">
                      Don't touch these during normal use.
                    </p>
                    <p>
                      These are <strong>system</strong> update settings — they control
                      where LibreServ itself gets its updates from. They have
                      nothing to do with the apps you install (those come from
                      App Sources in Settings, not here). Changing them without
                      knowing what you're doing can break or block LibreServ's
                      own updates. Leave them alone unless you're sure you need
                      to point LibreServ at a different update source.
                    </p>
                  </div>
                </div>
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
        </SettingsCard>
      )}

      {modalOpen && (
        <ModalCard title="Update Source" onClose={() => setModalOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-primary/70">
              Where LibreServ gets its own updates from. This is not for app
              updates — those come from App Sources in Settings.
            </p>
            <div className="space-y-1">
              <label className="block text-sm text-primary" htmlFor="us-base-url">
                API Base URL
              </label>
              <input
                id="us-base-url"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://gt.plainskill.net/api/v1"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm text-primary" htmlFor="us-owner">
                Owner
              </label>
              <input
                id="us-owner"
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="libreloom"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm text-primary" htmlFor="us-repo">
                Repo
              </label>
              <input
                id="us-repo"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="libreserv"
                className={inputClass}
              />
            </div>

            {saveError && <p className="text-sm text-error">{saveError}</p>}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="primary"
                loading={saving}
                disabled={!dirty}
                onClick={handleSave}
                className="flex-1"
              >
                {saving ? null : "Save changes"}
              </Button>
              <Button
                type="button"
                variant="outline"
                surface="secondary"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        </ModalCard>
      )}
    </div>
  );
}

AboutCategory.propTypes = {
  settings: PropTypes.object,
  onUpdateSourceSave: PropTypes.func,
};