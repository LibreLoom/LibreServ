import { useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronUp,
  Download,
  Heart,
  Images,
  Link2,
  ListChecks,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Button from "../ui/Button.jsx";
import Spinner from "../ui/Spinner.jsx";
import { haptic } from "../../utils/haptics.js";

// One sequence for both directions — the exit is this same animation played
// in reverse via Animation.reverse(), so interrupting select mode turns the
// bar around from wherever it is instead of restarting a separate exit tween.
// The fade resolves early (offset 0.55) so the last stretch is a soft landing.
const BAR_KEYFRAMES = [
  { opacity: 0, transform: "translateY(20px) scale(0.96)" },
  { opacity: 1, transform: "translateY(4px) scale(0.99)", offset: 0.55 },
  { opacity: 1, transform: "none" },
];
// Reduced motion keeps the fade, drops the travel.
const BAR_KEYFRAMES_REDUCED = [{ opacity: 0 }, { opacity: 1 }];
const BAR_EASING = "cubic-bezier(0.05, 0.7, 0.1, 1)"; // --motion-easing-emphasized-decelerate
const BAR_DURATION_MS = 250; // --motion-duration-medium1
const BAR_DURATION_REDUCED_MS = 150; // --motion-duration-short3

/**
 * Floating pill of bulk actions for selected photos (Files-style chrome).
 * On mobile it's an edge-to-edge bottom bar that expands into a labeled
 * action sheet; on sm+ it's the floating pill with inline labels.
 *
 * @param {{
 *   count: number,
 *   visible: boolean,
 *   onSelectAll?: () => void,
 *   onFavorite?: () => void,
 *   onAddToAlbum?: () => void,
 *   onNewAlbum?: () => void,
 *   onShare?: () => void,
 *   onDownload?: () => void,
 *   onArchive?: () => void,
 *   onTrash?: () => void,
 *   onRemoveFromAlbum?: () => void,
 *   onClear?: () => void,
 *   favoriting?: boolean,
 *   archiving?: boolean,
 *   busy?: boolean,
 * }} props
 */
export default function SelectionActionBar({
  count,
  visible,
  onSelectAll,
  onFavorite,
  onAddToAlbum,
  onNewAlbum,
  onShare,
  onDownload,
  onArchive,
  onTrash,
  onRemoveFromAlbum,
  onClear,
  favoriting = false,
  archiving = false,
  busy = false,
}) {
  // Stay mounted through the exit: the entrance animation object is kept and
  // reverse()d when select mode ends; it unmounts on its reversed finish.
  // Without WAAPI (old browsers, jsdom) there's no motion — mounted just
  // tracks `visible`.
  const canAnimate =
    typeof Element !== "undefined" &&
    typeof Element.prototype.animate === "function";
  const [rendered, setRendered] = useState(visible);
  const [actionsOpen, setActionsOpen] = useState(false);
  const barRef = useRef(null);
  const animRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  if (visible && !rendered) setRendered(true);
  const mounted = canAnimate ? rendered : visible;

  // Layout effect so the 0% keyframe is applied before first paint — an
  // ordinary effect could let the settled bar flash for a frame.
  useLayoutEffect(() => {
    if (!rendered || !canAnimate) return;
    const el = barRef.current;
    if (!el) return;
    if (!animRef.current) {
      const reduced =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const anim = el.animate(reduced ? BAR_KEYFRAMES_REDUCED : BAR_KEYFRAMES, {
        duration: reduced ? BAR_DURATION_REDUCED_MS : BAR_DURATION_MS,
        easing: BAR_EASING,
        fill: "both",
      });
      anim.onfinish = () => {
        if (anim.playbackRate < 0 && !visibleRef.current) {
          animRef.current = null;
          setRendered(false);
        }
      };
      animRef.current = anim;
    }
    const anim = animRef.current;
    if (visible !== (anim.playbackRate > 0)) anim.reverse();
  }, [rendered, visible, canAnimate]);

  useEffect(
    () => () => {
      animRef.current?.cancel();
      animRef.current = null;
    },
    []
  );

  // Everything except "Select all" acts on the current selection, so it
  // stays disabled until at least one photo is picked.
  const noneSelected = count <= 0;
  const actions = [
    onSelectAll && { key: "all", icon: ListChecks, label: "Select all", onClick: onSelectAll, needsSelection: false },
    onFavorite && { key: "fav", icon: Heart, label: "Favorite", onClick: onFavorite, loading: favoriting, needsSelection: true },
    onAddToAlbum && { key: "album", icon: Images, label: "Add to album", onClick: onAddToAlbum, needsSelection: true },
    onNewAlbum && { key: "new", icon: Plus, label: "New album", onClick: onNewAlbum, needsSelection: true },
    onRemoveFromAlbum && { key: "remove", icon: Minus, label: "Remove from album", onClick: onRemoveFromAlbum, needsSelection: true },
    onShare && { key: "share", icon: Link2, label: "Share", onClick: onShare, needsSelection: true },
    onDownload && { key: "download", icon: Download, label: "Download", onClick: onDownload, needsSelection: true },
    onArchive && { key: "archive", icon: Archive, label: "Archive", onClick: onArchive, loading: archiving, needsSelection: true },
    onTrash && { key: "trash", icon: Trash2, label: "Trash", onClick: onTrash, needsSelection: true },
  ].filter(Boolean);

  if (!mounted) return null;

  // Portal to <body>: position:fixed is resolved against the viewport only
  // when no ancestor creates a containing block (transform/filter/animation).
  // Page-level enter animations do, so without a portal the bar would scroll
  // with the timeline instead of staying pinned.
  return createPortal(
    <div
      data-slot="selection-action-bar"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center sm:bottom-24 sm:px-4"
    >
      <div
        ref={barRef}
        role="toolbar"
        aria-label="Actions for selected photos"
        className="pointer-events-auto flex w-full flex-col gap-1 rounded-t-large-element border-t-2 border-primary/20 bg-secondary px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] text-primary shadow-lg sm:w-auto sm:max-w-full sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-2 sm:rounded-pill sm:border-2 sm:px-3 sm:py-2"
      >
        {/* Header row (mobile) / leading items (desktop pill via sm:contents) */}
        <div className="flex items-center justify-between gap-2 sm:contents">
          <span className="font-mono text-xs shrink-0 rounded-pill bg-primary text-secondary px-2.5 py-1">
            {count} selected
          </span>
          <div className="flex items-center gap-1 sm:contents">
            {onSelectAll && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onSelectAll}
                disabled={busy}
                aria-label="Select all"
                // hidden at mobile widths → mounted display:none →
                // smoothResize would pin width:0px, so opt out.
                smoothResize={false}
                className="hidden sm:inline-flex"
              >
                <ListChecks size={16} />
                <span className="hidden sm:inline">Select all</span>
              </Button>
            )}
            {onClear && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClear}
                disabled={busy || noneSelected}
                aria-label="Clear selection"
                smoothResize={false}
                className="hidden sm:inline-flex"
              >
                <X size={16} />
                <span className="hidden sm:inline">Clear</span>
              </Button>
            )}
            {/* Mobile: toggles the labeled action sheet */}
            <Button
              variant="ghost"
              size="sm"
              smoothResize={false}
              className="sm:hidden"
              aria-expanded={actionsOpen}
              aria-label={actionsOpen ? "Hide actions" : "Show actions"}
              onClick={() => {
                haptic("light");
                setActionsOpen((o) => !o);
              }}
            >
              <span>Actions</span>
              <ChevronUp
                size={16}
                className={`motion-safe:transition-transform motion-safe:duration-200 ${actionsOpen ? "" : "rotate-180"}`}
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>

        {/* Mobile: collapsible action sheet with icon + label rows */}
        <div
          className={`grid sm:hidden motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)] ${
            actionsOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"
          }`}
          aria-hidden={!actionsOpen}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-0.5 py-1">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  disabled={busy || a.loading || (a.needsSelection && noneSelected)}
                  tabIndex={actionsOpen ? 0 : -1}
                  className="flex w-full items-center gap-3 rounded-pill px-3 py-2.5 text-left font-mono text-sm transition-colors hover:bg-primary/10 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => {
                    haptic("selection");
                    setActionsOpen(false);
                    a.onClick();
                  }}
                >
                  {a.loading ? (
                    <Spinner decorative size="sm" className="shrink-0" />
                  ) : (
                    <a.icon size={17} className="shrink-0 text-accent" aria-hidden="true" />
                  )}
                  {a.label}
                </button>
              ))}
              {onClear && (
                <>
                  <div className="my-1 h-px bg-primary/10 mx-2" aria-hidden="true" />
                  <button
                    type="button"
                    disabled={busy || noneSelected}
                    tabIndex={actionsOpen ? 0 : -1}
                    className="flex w-full items-center gap-3 rounded-pill px-3 py-2.5 text-left font-mono text-sm transition-colors hover:bg-primary/10 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => {
                      haptic("light");
                      setActionsOpen(false);
                      onClear();
                    }}
                  >
                    <X size={17} className="shrink-0 text-accent" aria-hidden="true" />
                    Clear selection
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Desktop: inline ghost buttons inside the pill */}
        <div className="hidden sm:contents">
          {actions
            .filter((a) => a.key !== "all")
            .map((a) => (
              <Button
                key={a.key}
                variant="ghost"
                size="sm"
                loading={a.loading}
                disabled={busy || (a.needsSelection && noneSelected)}
                onClick={a.onClick}
                aria-label={a.label}
                smoothResize={false}
              >
                <a.icon size={16} />
                <span className="hidden sm:inline">{a.label}</span>
              </Button>
            ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

SelectionActionBar.propTypes = {
  count: PropTypes.number.isRequired,
  visible: PropTypes.bool.isRequired,
  onSelectAll: PropTypes.func,
  onFavorite: PropTypes.func,
  onAddToAlbum: PropTypes.func,
  onNewAlbum: PropTypes.func,
  onShare: PropTypes.func,
  onDownload: PropTypes.func,
  onArchive: PropTypes.func,
  onTrash: PropTypes.func,
  onRemoveFromAlbum: PropTypes.func,
  onClear: PropTypes.func,
  favoriting: PropTypes.bool,
  archiving: PropTypes.bool,
  busy: PropTypes.bool,
};
