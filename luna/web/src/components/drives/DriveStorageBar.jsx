import PropTypes from "prop-types";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { formatBytes } from "../../lib/formatBytes.js";

/**
 * A drive's free space, how much is used, and a usage bar. Every drive card
 * shows its space through this one component, so the Dashboard and Files agree.
 *
 * It never invents numbers: without a real reading it says why (still
 * checking, could not read, nothing to read yet) — or says nothing with
 * `quiet`, for a card that already explains the drive's state.
 *
 * The bar fills with a transform, not a width, so a refetch repaints one layer
 * instead of re-laying out the card.
 *
 * @param {{
 *   summary: { data?: any, isLoading?: boolean, isError?: boolean },
 *   quiet?: boolean,
 * }} props
 */
export default function DriveStorageBar({ summary, quiet = false }) {
  const data = summary.data;
  const freeLabel = formatBytes(data?.free_bytes);
  const totalLabel = formatBytes(data?.total_bytes);
  const hasSpace = Boolean(
    data?.mounted && data?.total_bytes != null && Number(data.total_bytes) > 0 && freeLabel && totalLabel,
  );

  if (hasSpace) {
    const usedLabel = formatBytes(data.used_bytes);
    const ratio = Number(data.used_bytes) / Number(data.total_bytes);
    const usedPct = Number.isFinite(ratio) ? Math.min(100, Math.max(0, Math.round(ratio * 100))) : 0;
    return (
      <div data-slot="drive-storage-bar">
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-block size-2 shrink-0 rounded-full surface-secondary" aria-hidden="true" />
          <span className="text-xs font-mono">
            <TermHint content="How much room is left for new files on this drive." surface="primary">
              Available storage
            </TermHint>
          </span>
        </div>
        <div className="text-2xl font-mono font-normal leading-tight">{freeLabel} free</div>
        <p className="mt-1 text-sm">
          {usedLabel ? `${usedLabel} used · ` : ""}
          {totalLabel} total
        </p>
        <div
          className="mt-3 h-2 overflow-hidden rounded-pill surface-primary border border-secondary/30"
          role="progressbar"
          aria-valuenow={usedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${usedPct}% used`}
        >
          <div
            className="h-full w-full origin-left surface-secondary motion-safe:transition-transform motion-safe:duration-500"
            style={{ transform: `scaleX(${usedPct / 100})` }}
          />
        </div>
      </div>
    );
  }

  if (quiet) return null;
  if (summary.isLoading) return <p className="text-sm">Checking space…</p>;
  if (summary.isError) {
    return <p className="text-sm">Luna couldn&apos;t read the free space. It tries again every minute.</p>;
  }
  return <p className="text-sm">Storage will show once Luna can read this drive.</p>;
}

DriveStorageBar.propTypes = {
  summary: PropTypes.shape({
    data: PropTypes.any,
    isLoading: PropTypes.bool,
    isError: PropTypes.bool,
  }).isRequired,
  quiet: PropTypes.bool,
};
