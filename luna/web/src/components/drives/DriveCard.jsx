import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import LayeredCard from "@libreloom/ui/components/cards/LayeredCard.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

/**
 * The shelf's arrow: a filled disc that slides when the band is hovered. It is
 * the card's only "this goes somewhere" mark, so it sits in the same corner on
 * every drive card, on every page.
 */
function ShelfArrow() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-pill surface-primary motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-1">
      <ArrowRight size={ICON_SIZE.md} aria-hidden="true" />
    </span>
  );
}

/**
 * A drive, in two layers: the tray's foot is the way in (the shelf), the panel
 * is the drive itself. Every drive card in the app is this component, so the
 * way into a drive sits in the same place on the Dashboard and on Files.
 *
 * The shelf is the card's one action — Open, the grant's own label, Add drive,
 * Show progress — and is left empty when there is nothing to press, so a column
 * of drives keeps one rhythm instead of sprouting buttons that would not work.
 *
 * @param {{
 *   icon?: React.ReactElement,
 *   title: React.ReactNode,
 *   headerActions?: React.ReactNode,
 *   children?: React.ReactNode,
 *   action?: { label: string, to?: string, onClick?: () => void, disabled?: boolean } | null,
 *   className?: string,
 * }} props
 */
export default function DriveCard({ icon, title, headerActions, children, action, className }) {
  const asLink = Boolean(action?.to);
  return (
    <LayeredCard
      size="md"
      fullWidth
      className={className}
      icon={icon}
      title={title}
      headerActions={headerActions}
      actionLabel={action?.label}
      actionTrailing={action ? <ShelfArrow /> : null}
      onAction={action?.onClick}
      actionDisabled={action?.disabled}
      actionAs={asLink ? Link : undefined}
      actionProps={asLink ? { to: action.to } : undefined}
    >
      {children}
    </LayeredCard>
  );
}
