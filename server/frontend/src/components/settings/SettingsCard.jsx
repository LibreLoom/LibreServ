import { memo } from "react";
import Card from "../cards/Card";

const STAGGER_DELAY_MS = 50;
// Small base delay so no card animates at exactly 0ms. `.animate-in` uses
// `animation-fill-mode: both`, so a positive delay holds the card in its
// "before" state (opacity 0, shifted down) until the delay elapses. That
// protects the entrance animation when a card mounts during a busy commit —
// e.g. the several data-gated cards here that all mount at once the moment the
// network API resolves. At exactly 0ms the animation clock starts at DOM
// insertion and can be mostly elapsed by the first paint, so the card just
// "pops" in with no visible animation (this is what happened to the first,
// index-0 Remote Access card).
const BASE_DELAY_MS = 40;

/**
 * Standardized settings card with staggered fly-in-from-bottom animation.
 * Drop-in replacement for Card in settings pages.
 *
 * @param {{ index?: number, [key: string]: any }} _
 */
function SettingsCard({ index = 0, ...props }) {
  const delay = BASE_DELAY_MS + index * STAGGER_DELAY_MS;

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Card noPopIn {...props} />
    </div>
  );
}

export default memo(SettingsCard);
