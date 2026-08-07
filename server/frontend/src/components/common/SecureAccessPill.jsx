import { Globe, ArrowUpRight } from "lucide-react";
import LayeredPill from "../ui/LayeredPill";
import { useSettingsStatus } from "../../hooks/useSettingsStatus";

/**
 * SecureAccessPill — a compact layered pill shown next to the critical-issues
 * pill in the dashboard header. Tells the user they can reach their server
 * securely over their configured domain.
 *
 * Only rendered when a real domain is configured AND the page is not already
 * being served over HTTPS with that domain — if you're already on the secure
 * domain, the hint is redundant.
 */
export default function SecureAccessPill() {
  const { domainConfigured, domain } = useSettingsStatus();

  if (!domainConfigured || !domain || window.location.protocol === "https:")
    return null;

  return (
    <LayeredPill
      mono
      icon={<Globe size={12} />}
      actionIcon={<ArrowUpRight size={11} />}
      actionLabel={domain}
      onAction={() => window.open(`https://${domain}`, "_blank", "noopener,noreferrer")}
      actionAriaLabel={`Open ${domain} in a new tab`}
    >
      <span className="text-accent">Access securely</span>
    </LayeredPill>
  );
}