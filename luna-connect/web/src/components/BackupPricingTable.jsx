import { InfoHint } from "./ui/Tooltip.jsx";

const PRICING_ROWS = [
  { label: "Storage", value: "$8 / terabyte / month", mono: true },
  { label: "Downloads", value: "Free up to 3× monthly average", mono: false },
  { label: "Extra download traffic", value: "$0.01 / GB", mono: true },
];

/** Scannable pricing rows — label left, value right, one line per row. */
export function BackupPricingTable({ surface = "secondary", className = "" }) {
  return (
    <section className={`space-y-3 ${className}`.trim()} aria-labelledby="backup-pricing-heading">
      <div className="flex items-center gap-2">
        <h4 id="backup-pricing-heading" className="font-mono text-xs uppercase tracking-widest text-foreground">
          Pricing
        </h4>
        <InfoHint
          surface={surface}
          delayMs={0}
          label="How cloud backup pricing works"
          content="We bill from your average storage over the month, not a single day. Downloads are free up to three times that monthly average; extra download traffic costs $0.01 per GB."
        />
      </div>
      <div
        className="overflow-x-auto rounded-large-element border border-border"
        data-testid="backup-pricing-table"
      >
        <table className="w-full text-sm">
          <tbody>
            {PRICING_ROWS.map((row, index) => (
              <tr
                key={row.label}
                className={index < PRICING_ROWS.length - 1 ? "border-b border-border" : ""}
              >
                <th
                  scope="row"
                  className="px-4 py-3 text-left font-normal align-middle whitespace-nowrap"
                >
                  {row.label}
                </th>
                <td
                  className={`px-4 py-3 text-right align-middle ${row.mono ? "font-mono whitespace-nowrap" : ""}`}
                >
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
