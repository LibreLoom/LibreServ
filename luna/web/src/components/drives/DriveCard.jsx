import { Link } from "react-router-dom";
import LayeredCard from "@libreloom/ui/components/cards/LayeredCard.jsx";

/**
 * A drive, in two layers: the tray's band says which drive this is and opens
 * it, the panel is the drive's contents. Every drive card in the app is this
 * component, so a drive reads the same on the Dashboard and on Files.
 *
 * The band's one action is the arrow disc — Open, the grant's own label, Add
 * drive, Show progress — and is left out when there is nothing to press, so a
 * column of drives keeps one rhythm instead of sprouting buttons that would not
 * work.
 *
 * @param {{
 *   icon?: React.ReactElement,
 *   title: React.ReactNode,
 *   status?: React.ReactNode,
 *   children?: React.ReactNode,
 *   action?: { label: string, to?: string, onClick?: () => void, disabled?: boolean } | null,
 *   className?: string,
 * }} props
 */
export default function DriveCard({ icon, title, status, children, action, className }) {
  const asLink = Boolean(action?.to);
  return (
    <LayeredCard
      className={className}
      icon={icon}
      title={title}
      panelActions={status}
      actionLabel={action?.label}
      onAction={action?.onClick}
      actionDisabled={action?.disabled}
      actionAs={asLink ? Link : undefined}
      actionProps={asLink ? { to: action.to } : undefined}
    >
      {children}
    </LayeredCard>
  );
}
