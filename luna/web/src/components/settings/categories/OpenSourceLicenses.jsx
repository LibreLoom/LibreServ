import PropTypes from "prop-types";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ScrollText } from "lucide-react";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { OPEN_SOURCE_LICENSES } from "../../../lib/openSourceLicenses.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

/** Full license text, fetched on demand from web/public/licenses/. */
function useLicenseText(entry) {
  return useQuery({
    queryKey: ["license-text", entry?.licenseFile],
    queryFn: async () => {
      const res = await fetch(/** @type {string} */ (entry?.licenseFile));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    enabled: Boolean(entry?.licenseFile),
    staleTime: Infinity,
    retry: false,
  });
}

function LicenseModal({ entry, onClose }) {
  const text = useLicenseText(entry);
  return (
    <ModalCard
      open={Boolean(entry)}
      onClose={onClose}
      title={entry?.name ?? ""}
      size="lg"
    >
      {entry && (
        <div className="space-y-3">
          <p className="text-sm text-primary leading-relaxed">{entry.what}</p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="font-mono text-xs uppercase tracking-widest text-accent pt-0.5 shrink-0 w-20">
                License
              </dt>
              <dd className="text-primary">{entry.license}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-mono text-xs uppercase tracking-widest text-accent pt-0.5 shrink-0 w-20">
                Copyright
              </dt>
              <dd className="text-primary">{entry.copyright}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-mono text-xs uppercase tracking-widest text-accent pt-0.5 shrink-0 w-20">
                Source
              </dt>
              <dd>
                <a
                  href={entry.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline decoration-accent underline-offset-2 hover:text-secondary break-all"
                >
                  {entry.source.replace(/^https?:\/\//, "")}
                  <ExternalLink size={ICON_SIZE.xs} aria-hidden="true" />
                </a>
              </dd>
            </div>
          </dl>
          {entry.notices && (
            <p className="text-xs text-accent leading-relaxed">{entry.notices}</p>
          )}
          {entry.licenseFile ? (
            text.isLoading ? (
              <div className="space-y-2 py-2" aria-hidden="true">
                <div className="h-3 w-full rounded-pill bg-accent/30 animate-pulse" />
                <div className="h-3 w-5/6 rounded-pill bg-accent/30 animate-pulse" />
                <div className="h-3 w-2/3 rounded-pill bg-accent/30 animate-pulse" />
              </div>
            ) : text.isError ? (
              <p className="text-sm text-error">
                Couldn't load the license text. It's bundled with Luna at{" "}
                <span className="font-mono">{entry.licenseFile}</span>.
              </p>
            ) : (
              <pre className="max-h-[45vh] overflow-y-auto rounded-large-element border border-primary/20 bg-primary/5 p-4 font-mono text-xs leading-relaxed text-primary whitespace-pre-wrap">
                {text.data}
              </pre>
            )
          ) : entry.licenseUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={entry.licenseUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={ICON_SIZE.sm} aria-hidden="true" />
                Read the {entry.license}
              </a>
            </Button>
          ) : null}
        </div>
      )}
    </ModalCard>
  );
}

LicenseModal.propTypes = {
  entry: PropTypes.object,
  onClose: PropTypes.func.isRequired,
};

/**
 * Collapsible registry of the open source components Luna serves, inside
 * the About → Luna card. Each row opens a modal with the full license text
 * (bundled under /licenses so it works offline) plus copyright and source.
 * New vendored components only need an entry in OPEN_SOURCE_LICENSES.
 */
export default function OpenSourceLicenses() {
  const [openEntry, setOpenEntry] = useState(null);
  return (
    <>
      <CollapsibleSection title="Open source licenses" mono pill>
        <p className="text-sm text-accent leading-relaxed mb-3">
          Luna builds on open source. These are the components that ship with
          the optional office editor — everything runs on this Luna, not in
          the cloud.
        </p>
        <ul className="space-y-2">
          {OPEN_SOURCE_LICENSES.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 px-1 py-1"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium text-primary">
                    {entry.name}
                  </span>
                  <span className="rounded-pill border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-primary">
                    {entry.license}
                  </span>
                </div>
                <p className="mt-1 text-xs text-accent leading-relaxed">
                  {entry.what}
                </p>
              </div>
              <Button
                variant="outline"
                surface="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => setOpenEntry(entry)}
                aria-label={`Open ${entry.name} license`}
              >
                <ScrollText size={ICON_SIZE.sm} aria-hidden="true" />
                License
              </Button>
            </li>
          ))}
        </ul>
      </CollapsibleSection>
      <LicenseModal entry={openEntry} onClose={() => setOpenEntry(null)} />
    </>
  );
}
