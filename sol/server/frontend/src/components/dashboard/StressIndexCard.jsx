import { cn } from "@/lib/utils";
import Card from "../cards/Card";
import CollapsibleSection from "../common/CollapsibleSection";
import PillGauge from "../ui/PillGauge";
import { ICON_SIZE } from "@/lib/ui-tokens";

/** Stress level → semantic variant + plain-language label. */
function stressLevel(pct) {
  if (pct < 30) return { variant: "success", label: "Light load" };
  if (pct < 60) return { variant: "warning", label: "Moderate load" };
  if (pct < 85) return { variant: "warning", label: "Heavy load" };
  return { variant: "error", label: "Very heavy load" };
}

/** Variant for an individual resource based on its own percentage. */
function resourceVariant(pct) {
  if (pct < 30) return "success";
  if (pct < 60) return "warning";
  return "error";
}

/** Extract numeric percentage from a string like "42%". */
function parsePct(str) {
  const m = String(str).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * StressIndexCard — dashboard metric showing aggregate server load.
 *
 * Design: a PillGauge fills proportionally to the stress percentage,
 * colored by severity. The big percentage is the hero, with a plain-
 * language status label beside it. The collapsible breakdown shows each
 * resource as its own PillGauge — so the user sees which resource is
 * driving the load at a glance.
 *
 * @param {{ value: string, breakdownItems: Array<{ icon: import('react').ElementType, label: string, value: string }> }} props
 */
export default function StressIndexCard({ value, breakdownItems = [] }) {
  const pct = parsePct(value);
  const level = stressLevel(pct);
  const isLoading = breakdownItems.length === 0;

  return (
    <Card
      data-slot="stress-index-card"
      padding={false}
      className="overflow-hidden"
    >
      <div className="p-6">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs font-mono uppercase tracking-widest text-accent">
            Server Stress Index
          </div>
          <div className={cn("text-xs font-mono", `text-${level.variant}`)}>
            {level.label}
          </div>
        </div>

        {/* Hero percentage */}
        <div className="text-3xl font-mono font-normal leading-tight mb-4">
          {value}
        </div>

        {/* PillGauge */}
        <PillGauge value={pct} variant={level.variant} aria-label="Server stress level" />
      </div>

      {/* Breakdown — each resource as its own PillGauge */}
      <div className="px-6 pb-4">
        <CollapsibleSection title="Breakdown" size="sm" pill>
          <div className="space-y-3 pt-1">
            {isLoading ? (
              <div className="text-center py-3 px-4 text-primary font-mono">
                Loading...
              </div>
            ) : (
              breakdownItems.map((item) => {
                const itemPct = parsePct(item.value);
                const ItemIcon = item.icon;
                return (
                  <div key={item.label} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <ItemIcon
                        size={ICON_SIZE.xs}
                        className="text-accent shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-mono text-accent">
                        {item.label}
                      </span>
                      <span className="text-xs font-mono text-primary ml-auto">
                        {item.value}
                      </span>
                    </div>
                    <PillGauge
                      value={itemPct}
                      variant={resourceVariant(itemPct)}
                      segments={16}
                      aria-label={`${item.label} usage`}
                    />
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleSection>
      </div>
    </Card>
  );
}
