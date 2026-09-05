import { InfoHint } from "./ui/Tooltip.jsx";

const PRICING_ROWS = [
  { label: "Storage", value: "$8 / terabyte / month", mono: true },
  { label: "Downloads", value: "Free up to 3× stored amount", mono: false },
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
          content="We bill from your average storage over the month, not a single day. Downloads are free up to 3× stored amount; extra download traffic costs $0.01 per GB."
        />
      </div>
      <div
        className="rounded-large-element border border-border overflow-hidden"
        data-testid="backup-pricing-table"
      >
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[42%]" />
            <col className="w-[58%]" />
          </colgroup>
          <tbody>
            {PRICING_ROWS.map((row, index) => (
              <tr
                key={row.label}
                className={index < PRICING_ROWS.length - 1 ? "border-b border-border" : ""}
              >
                <th
                  scope="row"
                  className="px-4 py-3 text-left font-normal align-middle break-words"
                >
                  {row.label}
                </th>
                <td
                  className={`px-4 py-3 text-right align-middle break-words ${row.mono ? "font-mono" : ""}`}
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
