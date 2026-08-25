import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

const CELL_BASE = "py-2.5 bg-secondary text-primary";
const CELL_FIRST = "pl-3 rounded-l-large-element";
const CELL_LAST = "pr-3 rounded-r-large-element";
const CELL_MIDDLE = "px-1";

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** @param {{ columns: any, data: any, rowKey: any, scrollable?: any, maxHeight?: any, className?: string, headClassName?: string, onRowClick?: (row: any, rowIndex: number) => void }} _ */
export default function Table({ columns, data, rowKey, scrollable, maxHeight, className = "", headClassName = "text-accent", onRowClick }) {
  const wrapperStyle = scrollable ? { maxHeight: maxHeight || "24rem" } : undefined;

  return (
    <div className={cn("bg-primary/5 rounded-card p-3", className)} data-slot="table">
      <div className={scrollable ? "overflow-y-auto" : undefined} style={wrapperStyle}>
        <table className="w-full text-sm border-separate border-spacing-y-2">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    // Column labels use the same eyebrow the dashboard stat
                    // cards and MfaCard sections use: mono, uppercase, tracked
                    // out and quiet, so the row pills stay the loud element.
                    `${ALIGN[col.align] || ALIGN.left} px-3 pt-0.5 pb-2.5 font-mono whitespace-nowrap text-[15px] font-normal uppercase tracking-[0.14em] ${headClassName}`,
                    col.hidden ? `hidden ${col.hidden}:table-cell` : "",
                    col.width || "",
                  )}
                >
                  {col.srOnly ? <span className="sr-only">{col.label}</span> : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIndex) => {
              const key = rowKey ? row[rowKey] : rowIndex;
              return (
                <tr
                  key={key}
                  className={cn(
                    "group",
                    onRowClick &&
                      "cursor-pointer motion-safe:transition-[translate] duration-200 ease-[var(--motion-easing-standard)] hover:motion-safe:translate-x-0.5 active:motion-safe:translate-x-0",
                  )}
                  onClick={
                    onRowClick
                      ? () => {
                          // Don't hijack a click that was really a text selection.
                          if (window.getSelection()?.toString()) return;
                          onRowClick(row, rowIndex);
                        }
                      : undefined
                  }
                >
                  {columns.map((col, colIndex) => {
                    const isFirst = colIndex === 0;
                    const isLast = colIndex === columns.length - 1;
                    const cellClasses = [
                      CELL_BASE,
                      isFirst ? CELL_FIRST : "",
                      isLast ? CELL_LAST : "",
                      !isFirst && !isLast ? CELL_MIDDLE : "",
                      col.hidden ? `hidden ${col.hidden}:table-cell` : "",
                      // The tint has to live on the cells — that is where
                      // bg-secondary is, and a transition on the <tr> would never
                      // fire for it. It has to be OPAQUE: a translucent fill is
                      // painted per cell, so at the fractional offsets the row
                      // passes through mid-slide the shared edges blend twice and
                      // show as vertical hairlines between the cells.
                      onRowClick
                        // color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
                        ? "motion-safe:transition-[background-color] duration-200 ease-[var(--motion-easing-standard)] group-hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--primary))]"
                        : "",
                    ].filter(Boolean).join(" ");

                    const content = col.render
                      ? col.render(row, rowIndex)
                      : row[col.key];

                    return (
                      <td
                        key={col.key}
                        className={cn(cellClasses)}
                        onClick={col.noRowClick ? (e) => e.stopPropagation() : undefined}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

Table.propTypes = {
  columns: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      render: PropTypes.func,
      hidden: PropTypes.string,
      align: PropTypes.oneOf(["left", "center", "right"]),
      width: PropTypes.string,
      srOnly: PropTypes.bool,
      noRowClick: PropTypes.bool,
    })
  ).isRequired,
  data: PropTypes.array.isRequired,
  rowKey: PropTypes.string,
  scrollable: PropTypes.bool,
  maxHeight: PropTypes.string,
  className: PropTypes.string,
  headClassName: PropTypes.string,
  onRowClick: PropTypes.func,
};