import { memo } from "react";
import Card from "../cards/Card";

const STAGGER_DELAY_MS = 25;
const MAX_STAGGER_DELAY_MS = 200;
const BASE_DELAY_MS = 30;

/**
 * Standardized settings card with staggered fly-in-from-bottom animation.
 *
 * @param {{ index?: number, [key: string]: any }} _
 */
function SettingsCard({ index = 0, ...props }) {
  const delay = Math.min(
    BASE_DELAY_MS + index * STAGGER_DELAY_MS,
    MAX_STAGGER_DELAY_MS,
  );

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-150 overflow-hidden"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Card noPopIn {...props} />
    </div>
  );
}

export default memo(SettingsCard);
