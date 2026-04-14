import { memo } from "react";
import Card from "../cards/Card";

const STAGGER_DELAY_MS = 50;

/**
 * Standardized settings card with staggered fly-in-from-bottom animation.
 * Drop-in replacement for Card in settings pages.
 *
 * @param {number} index - Position in the stagger sequence (0-based).
 *                          Determines animation delay (index × 50ms).
 */
function SettingsCard({ index = 0, ...props }) {
  const delay = index * STAGGER_DELAY_MS;

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={delay > 0 ? { animationDelay: `${delay}ms` } : undefined}
    >
      <Card noPopIn {...props} />
    </div>
  );
}

export default memo(SettingsCard);
