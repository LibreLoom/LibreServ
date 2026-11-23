import { useState, useEffect, useRef } from "react";
import { Heart, Coffee, Globe, AlertTriangle, GitBranch, Activity, CheckCircle2, XCircle } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import FactoryResetCard from "./FactoryResetCard";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { useSystemHealthCheck } from "../../../hooks/useSystemHealthCheck";
import api from "../../../lib/api";
import { labelFor } from "../../../lib/healthChecks";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const inputClass =
  "w-full px-3 py-2 text-sm font-mono rounded-pill bg-primary/10 border-2 border-primary/20 text-primary outline-none focus:border-accent";

function SystemChecksCard({ index = 2, isAdmin = false }) {
  const { data, isLoading, error } = useSystemHealthCheck();
  const [checkingFile, setCheckingFile] = useState(false);
  const [fileResult, setFileResult] = useState(null);
  const [fileProblem, setFileProblem] = useState(false);
  const [fileChecked, setFileChecked] = useState(false);
  const pollRef = useRef(null);
  const lastHealthRef = useRef(data);
  useEffect(() => () => pollRef.current?.abort(), []);
  useEffect(() => {
    // A newer health snapshot wins. Without this, a manual "fine" would keep
    // overriding a failed database row on every later poll.
    if (data !== lastHealthRef.current) {
      lastHealthRef.current = data;
      setFileChecked(false);
      setFileProblem(false);
      setFileResult(null);
    }
  }, [data]);

  // Always available to an admin, even when the periodic health query fails.
  const actionRow = isAdmin && (
    <div className="flex flex-wrap items-center gap-3 pb-4">
      <Button
        variant="outline"
        size="sm"
        onClick={checkDatabaseFile}
        loading={checkingFile}
      >
        Check the database file
      </Button>
      {fileResult && (
        <p className={`text-sm ${fileProblem ? "px-3 py-1 rounded-chip bg-error/20 border-2 border-error/30 text-primary" : ""}`} role="status">
          {fileResult}
        </p>
      )}
    </div>
  );

  async function checkDatabaseFile() {
    // Leaving Settings must stop the poll, even if a status request hangs.
    pollRef.current?.abort();
    const controller = new AbortController();
    pollRef.current = controller;
    setCheckingFile(true);
    setFileResult(null);
    setFileProblem(false);
    setFileChecked(false);
    let restartedIdle = false;
    // A single hung request must not disable the button forever. Bound every
    // call separately; the deadline below bounds the whole poll.
    const request = async (path, options = {}) => {
      const reqController = new AbortController();
      const onParentAbort = () => reqController.abort();
      controller.signal.addEventListener("abort", onParentAbort, { once: true });
      let timer;
      try {
        return await Promise.race([
          api(path, { ...options, signal: reqController.signal }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              // Abort the real fetch too; the race alone leaves it running.
              reqController.abort();
              reject(new Error("request-timeout"));
            }, 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onParentAbort);
      }
    };
    try {
      // The page walk runs in the background: the request only starts it,
      // then this card polls for the verdict. A big database can take its
      // full two minutes without hitting the 15 s HTTP write timeout.
      await request("/system/database/integrity", { method: "POST" });
      const deadline = Date.now() + 3 * 60_000;
      while (!controller.signal.aborted) {
        const res = await request("/system/database/integrity/status");
        const result = await res.json();
        if (result.status === "idle") {
          // A restart between starting and polling loses the job. Try once
          // more, then say it never started rather than claiming success.
          if (!restartedIdle) {
            restartedIdle = true;
            await request("/system/database/integrity", { method: "POST" });
            continue;
          }
          setFileResult("The database check hasn't started yet. Please try again.");
          break;
        }
        if (result.status !== "running") {
          // A timeout or a locked database is not a problem with the file.
          // A check that could not run is retryable, not a damaged file.
          setFileProblem(result.status === "corrupt" || result.reason === "corrupt" || result.reason === "missing");
          setFileChecked(result.status === "ok");
          setFileResult(result.message || "The database file is fine.");
          break;
        }
        if (Date.now() > deadline) {
          setFileResult("Sol couldn't finish checking the database file. Please try again.");
          break;
        }
        await new Promise((resolve) => {
          let timer;
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, 1500);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setFileProblem(false);
        setFileResult(err?.message === "request-timeout"
          ? "The database check took too long. Please try again."
          : "Sol couldn't check the database file right now. Please try again.");
        setCheckingFile(false);
      }
    } finally {
      if (!controller.signal.aborted) setCheckingFile(false);
    }
  }

  if (isLoading && !data) {
    return (
      <SettingsCard icon={Activity} title="System checks" padding={false} index={index}>
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
      <SettingsCard icon={Activity} title="System checks" padding={false} index={index}>
        <p className="px-5 pt-4 text-sm text-error">
          Couldn't check your system right now. Please try again later.
        </p>
        <div className="px-5">{actionRow}</div>
      </SettingsCard>
    );
  }

  const rawChecks = data?.checks ? Object.entries(data.checks) : [];
  // The cheap probe still reports the database connection as healthy when the
  // manual file check found damage. Replace that row so the card cannot argue
  // with itself.
  const checks = fileProblem || fileChecked
    ? rawChecks.map(([name, check]) => name === "database"
      ? [name, fileProblem
        ? { ...check, status: "failed", message: fileResult || "The database file needs attention." }
        : { ...check, status: "passed", message: "The database file is fine." }]
      : [name, check])
    : rawChecks;
  const summary = data?.summary;
  // A manual check can change the database row, so the old summary would
  // contradict it. Recount from the merged rows in that case.
  const recount = fileChecked || fileProblem;
  const passed = recount
    ? checks.filter(([, c]) => c.status === "passed").length
    : summary?.passed ?? checks.filter(([, c]) => c.status === "passed").length;
  const failed = recount ? checks.length - passed : summary?.failed ?? checks.length - passed;
  const allOk = failed === 0 && checks.length > 0 && !fileProblem;

  // Failed checks first, then alphabetical, so problems are the first thing seen.
  const ordered = [...checks].sort((a, b) => {
    const fa = a[1].status === "passed" ? 1 : 0;
    const fb = b[1].status === "passed" ? 1 : 0;
    return fa - fb || labelFor(a[0]).localeCompare(labelFor(b[0]));
  });

  return (
    <SettingsCard icon={Activity} title="System checks" padding={false} index={index}>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm">
            {fileProblem
              ? "The database file needs attention."
              : checks.length === 0
                ? "No checks recorded yet."
                : allOk
                  ? `${passed} of ${checks.length} checks passed — everything looks good.`
                  : `${failed} of ${checks.length} checks need attention.`}
          </p>
          <span
            className={cn(
              "text-xs px-3 py-1 rounded-chip font-medium shrink-0",
              allOk ? "bg-success/20 border-2 border-success/30 text-primary" : "bg-error/20 border-2 border-error/30 text-primary"
            )}
          >
            {allOk ? "Healthy" : "Issues found"}
          </span>
        </div>

        {actionRow}

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
                    <CheckCircle2 size={ICON_SIZE.md} className="text-success shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle size={ICON_SIZE.md} className="text-error shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-primary">{labelFor(name)}</div>
                    {check.message && (
                      <div className="text-xs truncate">{check.message}</div>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    "text-xs font-mono px-2.5 py-1 rounded-chip shrink-0",
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

export default function AboutCategory({ settings, onUpdateSourceSave, isAdmin = false }) {
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
      <SettingsCard icon={Heart} title="Sol" padding={false} index={0}>
        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed">
            Sol runs your apps and files on your own home server.
          </p>
          <div className="mt-4">
            <Button asChild variant="outline" surface="secondary">
              <a
                href="https://libreloom.org"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Globe size={ICON_SIZE.md} aria-hidden="true" />
                Visit libreloom.org
              </a>
            </Button>
          </div>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm">
              <Heart size={ICON_SIZE.sm} className="text-error" />
              <span>Made with love: for everyone, by everyone.</span>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard icon={Coffee} title="Support Sol" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed">
            Sol is free and open source. If it has made running your own
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
                <Coffee size={ICON_SIZE.md} aria-hidden="true" />
                Support us on Ko-fi
              </a>
            </Button>
          </div>
        </div>
      </SettingsCard>

      <SystemChecksCard index={2} isAdmin={isAdmin} />

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
              title="System update source"
              mono
              size="sm"
              pill
            >
              <div className="p-4 mb-3 rounded-large-element bg-warning/20 border-2 border-warning/30">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={ICON_SIZE.lg} className="text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="text-sm text-primary space-y-1.5">
                    <p className="font-semibold">
                      Don't touch these during normal use.
                    </p>
                    <p>
                      These are <strong>system</strong> update settings — they control
                      where Sol itself gets its updates from. They have
                      nothing to do with the apps you install (those come from
                      App Sources in Settings, not here). Changing them without
                      knowing what you're doing can break or block Sol's
                      own updates. Leave them alone unless you're sure you need
                      to point Sol at a different update source.
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
                <GitBranch size={ICON_SIZE.sm} aria-hidden="true" />
                Edit update source
              </Button>
            </CollapsibleSection>

            <FactoryResetCard index={4} className="border-2 border-primary/10" />
          </div>
        </SettingsCard>
      )}

      {modalOpen && (
        <ModalCard title="Update source" onClose={() => setModalOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm">
              Where Sol gets its own updates from. This is not for app
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
                placeholder="sol"
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
  isAdmin: PropTypes.bool,
};