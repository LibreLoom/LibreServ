import { cn } from "@/lib/utils";
import Card from "../cards/Card";

/**
 * MetricCard — a small centered label + value card used in stat grids.
 *
 * Replaces the repeated
 * `<Card className="flex flex-col items-center justify-center py-6 text-center"><p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">{label}</p>…</Card>`
 * pattern. The label uses the card's inherited text token; `valueClassName`
 * lets callers apply status colors.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {import("react").ReactNode} [props.value] The big mono value. Omit to use children.
 * @param {string} [props.valueClassName]
 * @param {import("react").ReactNode} [props.children]
 * @param {string} [props.className]
 */
export default function MetricCard({
  label,
  value,
  valueClassName = "",
  children,
  className = "",
}) {
  return (
    <Card className={cn("flex flex-col items-center justify-center py-6 text-center", className)} data-slot="metric-card">
      <p className="text-xs font-mono uppercase tracking-wider text-primary/50 mb-1">
        {label}
      </p>
      {value != null && (
        <p className={cn("text-2xl font-mono", valueClassName)}>
          {value}
        </p>
      )}
      {children}
    </Card>
  );
}