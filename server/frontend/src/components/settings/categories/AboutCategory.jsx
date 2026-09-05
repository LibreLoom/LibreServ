import { useState, useEffect } from "react";
import { Heart, Coffee, Globe, AlertTriangle, GitBranch, Activity, CheckCircle2, XCircle } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import SettingsCard from "../SettingsCard";
import FactoryResetCard from "./FactoryResetCard";
import Button from "../../ui/Button";
import CollapsibleSection from "../../common/CollapsibleSection";
import ModalCard from "../../cards/ModalCard";
import { useSystemHealthCheck } from "../../../hooks/useSystemHealthCheck";
import { labelFor } from "../../../lib/healthChecks";

const inputClass =
  "w-full px-3 py-2 text-sm font-mono rounded-pill bg-primary/10 border-2 border-primary/20 text-primary outline-none focus:border-accent";

function SystemChecksCard({ index = 2 }) {
  const { data, isLoading, error } = useSystemHealthCheck();

  if (isLoading && !data) {
    return (
      <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
        <div className="px-5 py-4 space-y-3 animate-pulse">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-4 h-4 rounded-full bg-primary/20" />
              <div className="h-3 rounded-pill bg-primary/10 flex-1" />
            </div>
          ))}
        </div>
      </SettingsCard>
    );
  }

  if (!data && error) {
    return (
      <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
        <p className="px-5 py-4 text-sm text-error">
          Couldn't check your system right now. Please try again later.
        </p>
      </SettingsCard>
    );
  }

  const checks = data?.checks ? Object.entries(data.checks) : [];
  const summary = data?.summary;
  const passed = summary?.passed ?? checks.filter(([, c]) => c.status === "passed").length;
  const failed = summary?.failed ?? checks.length - passed;
  const allOk = failed === 0 && checks.length > 0;

  // Failed checks first, then alphabetical, so problems are the first thing seen.
  const ordered = [...checks].sort((a, b) => {
    const fa = a[1].status === "passed" ? 1 : 0;
    const fb = b[1].status === "passed" ? 1 : 0;
    return fa - fb || labelFor(a[0]).localeCompare(labelFor(b[0]));
  });

  return (
    <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm text-accent">
            {checks.length === 0
              ? "No checks recorded yet."
              : allOk
                ? `${passed} of ${checks.length} checks passed — everything looks good.`
                : `${failed} of ${checks.length} checks need attention.`}
          </p>
          <span
            className={cn(
              "text-xs px-3 py-1 rounded-pill font-medium shrink-0",
              allOk ? "bg-success/20 border-2 border-success/30 text-primary" : "bg-error/20 border-2 border-error/30 text-primary"
            )}
          >
            {allOk ? "Healthy" : "Issues found"}
          </span>
        </div>

        <ul className="space-y-1">
          {ordered.map(([name, check]) => {
            const ok = check.status === "passed";
            return (
              <li
                key={name}
                className="flex items-center justify-between gap-3 py-2 border-b border-primary/10 last:border-0"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {ok ? (
                    <CheckCircle2 size={15} className="text-success shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle size={15} className="text-error shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-primary">{labelFor(name)}</div>
                    {check.message && (
                      <div className="text-xs text-accent truncate">{check.message}</div>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    "text-xs font-mono px-2.5 py-1 rounded-pill shrink-0",
                    ok ? "bg-success/20 text-primary" : "bg-error/20 text-primary"
                  )}
                >
                  {ok ? "OK" : "Issue"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsCard>
  );
}

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
          <div className="mt-4">
            <Button asChild variant="outline" surface="secondary">
              <a
                href="https://libreloom.org"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Globe size={16} aria-hidden="true" />
                Visit libreloom.org
              </a>
            </Button>
          </div>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={14} className="text-error" />
              <span>Made with love: for everyone, by everyone.</span>
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

      <SystemChecksCard index={2} />

      {/* Advanced — only rendered for admins, whose settings actually loaded. */}
      {updates != null && (
        <SettingsCard
          icon={AlertTriangle}
          title="Advanced"
          padding={false}
          index={3}
        >
          <div className="px-5 py-4 space-y-4">
            <CollapsibleSection
              title="System Update Source"
              mono
              size="sm"
              pill
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

            <FactoryResetCard index={4} className="border-2 border-primary/10" />
          </div>
        </SettingsCard>
      )}

      {modalOpen && (
        <ModalCard title="Update Source" onClose={() => setModalOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-accent">
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