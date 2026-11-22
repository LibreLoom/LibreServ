import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";
import { haptic } from "../../utils/haptics.js";

const CELL_BASE = "py-2.5 text-primary";
const CELL_BG = "surface-secondary";
const CELL_BG_PRIMARY = "surface-primary";
// color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
const CELL_BG_STRIPE = "bg-[color-mix(in_oklab,var(--secondary)_92%,var(--primary))]";
// color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
const CELL_BG_STRIPE_PRIMARY = "bg-[color-mix(in_oklab,var(--primary)_92%,var(--secondary))]";
const CELL_FIRST = "pl-3 rounded-l-large-element";
const CELL_LAST = "pr-3 rounded-r-large-element";
const CELL_MIDDLE = "px-1";

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const ROW_SLIDE =
  "cursor-pointer motion-safe:transition-[translate,background-color] duration-200 ease-[var(--motion-easing-standard)] hover:motion-safe:translate-x-0.5 active:motion-safe:translate-x-0";

const MD_UP_QUERY = "(min-width: 768px)";

// color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
const CARD_SLIDE =
  "cursor-pointer motion-safe:transition-[translate,background-color] duration-200 ease-[var(--motion-easing-standard)] hover:motion-safe:translate-x-0.5 active:motion-safe:translate-x-0 hover:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--primary))]";
// color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
const CARD_SLIDE_PRIMARY =
  "cursor-pointer motion-safe:transition-[translate,background-color] duration-200 ease-[var(--motion-easing-standard)] hover:motion-safe:translate-x-0.5 active:motion-safe:translate-x-0 hover:bg-[color-mix(in_oklab,var(--primary)_85%,var(--secondary))]";

/**
 * Mobile cards normally sit on the page (a secondary card on a primary
 * backdrop). A list nested in a secondary panel inverts that: a secondary
 * card would blend into its backdrop, so `primary` paints the cards with the
 * page token instead.
 */
const CARD_CHROME = {
  secondary: {
    bg: CELL_BG,
    stripe: CELL_BG_STRIPE,
    text: "text-primary",
    border: "border-primary/10",
    slide: CARD_SLIDE,
  },
  primary: {
    bg: CELL_BG_PRIMARY,
    stripe: CELL_BG_STRIPE_PRIMARY,
    text: "text-secondary",
    border: "border-secondary/10",
    slide: CARD_SLIDE_PRIMARY,
  },
};

/**
 * jsdom has no layout CSS, so mobile-card mode picks one chrome via matchMedia.
 * Missing matchMedia (SSR / some tests) is treated as desktop.
 */
function useIsMdUp() {
  const read = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia(MD_UP_QUERY).matches;
  };
  const [isMdUp, setIsMdUp] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(MD_UP_QUERY);
    const onChange = () => setIsMdUp(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMdUp;
}

/**
 * @param {{ columns: any, data: any, rowKey: any, scrollable?: any, maxHeight?: any, className?: string, headClassName?: string, onRowClick?: (row: any, rowIndex: number) => void, mobileCards?: boolean, renderMobileCard?: (row: any, columns: any, surface: "primary"|"secondary") => any, mobileCardSurface?: "primary"|"secondary", striped?: boolean }} _
 */
export default function Table({
  columns,
  data,
  rowKey,
  scrollable,
  maxHeight,
  className = "",
  headClassName = "",
  onRowClick,
  mobileCards = false,
  renderMobileCard,
  mobileCardSurface = "secondary",
  striped = false,
}) {
  const isMdUp = useIsMdUp();
  const showCards = mobileCards && !isMdUp;
  const wrapperStyle = scrollable ? { maxHeight: maxHeight || "24rem" } : undefined;
  const chrome = CARD_CHROME[mobileCardSurface];

  if (showCards) {
    // Columns marked `hidden` are desktop-only (hidden + `{bp}:table-cell`).
    const cardColumns = columns.filter((col) => !col.hidden);
    const fieldColumns = cardColumns.filter((col) => !col.srOnly);
    const actionColumns = cardColumns.filter((col) => col.srOnly);

    return (
      <div className={cn(className)} data-slot="table">
        <ul className="m-0 list-none space-y-3 p-0" aria-label="Rows">
          {data.map((row, rowIndex) => {
            const key = rowKey ? row[rowKey] : rowIndex;
            return (
              <li key={key}>
                {renderMobileCard ? (
                  <article
                    className={cn(
                      "rounded-large-element p-3",
                      chrome.text,
                      striped && rowIndex % 2 === 1 ? chrome.stripe : chrome.bg,
                      onRowClick && chrome.slide,
                    )}
                    onClick={
                      onRowClick
                        ? () => {
                            if (window.getSelection()?.toString()) return;
                            haptic("selection");
                            onRowClick(row, rowIndex);
                          }
                        : undefined
                    }
                  >
                    {renderMobileCard(row, columns, mobileCardSurface)}
                  </article>
                ) : (
                <article
                  className={cn(
                    "rounded-large-element p-4 flex flex-col gap-3",
                    chrome.text,
                    striped && rowIndex % 2 === 1 ? chrome.stripe : chrome.bg,
                    onRowClick &&
                      chrome.slide,
                  )}
                  onClick={
                    onRowClick
                      ? () => {
                          if (window.getSelection()?.toString()) return;
                          haptic("selection");
                          onRowClick(row, rowIndex);
                        }
                      : undefined
                  }
                >
                  {fieldColumns.map((col) => {
                    const content = col.render ? col.render(row, rowIndex, mobileCardSurface) : row[col.key];
                    return (
                      <div
                        key={col.key}
                        className="flex flex-col gap-1.5 min-w-0"
                        onClick={col.noRowClick ? (e) => e.stopPropagation() : undefined}
                      >
                        <span
                          className={cn(
                            "font-mono whitespace-nowrap text-[13px] font-normal",
                            headClassName,
                          )}
                        >
                          {col.label}
                        </span>
                        <div className="min-w-0">{content}</div>
                      </div>
                    );
                  })}
                  {actionColumns.length > 0 && (
                    <div className={cn("flex items-center justify-end gap-1 pt-1 border-t", chrome.border)}>
                      {actionColumns.map((col) => {
                        const content = col.render ? col.render(row, rowIndex, mobileCardSurface) : row[col.key];
                        return (
                          <div
                            key={col.key}
                            onClick={col.noRowClick ? (e) => e.stopPropagation() : undefined}
                          >
                            {content}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

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
                    // cards and MfaCard sections use: mono
                    // out and quiet, so the row pills stay the loud element.
                    `${ALIGN[col.align] || ALIGN.left} px-3 pt-0.5 pb-2.5 font-mono whitespace-nowrap text-[15px] font-normal ${headClassName}`,
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
                    // The whole row slides on hover. `will-change: transform`
                    // keeps the cells in one composited layer: without it,
                    // Chrome rasterises each cell's background on its own and
                    // a row stopped at a fractional offset shows hairline
                    // seams between them.
                    onRowClick && "cursor-pointer hover:will-change-transform",
                    onRowClick && ROW_SLIDE,
                  )}
                  onClick={
                    onRowClick
                      ? () => {
                          // Don't hijack a click that was really a text selection.
                          if (window.getSelection()?.toString()) return;
                          haptic("selection");
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
                      striped && rowIndex % 2 === 1 ? CELL_BG_STRIPE : CELL_BG,
                      isFirst ? CELL_FIRST : "",
                      isLast ? CELL_LAST : "",
                      !isFirst && !isLast ? CELL_MIDDLE : "",
                      col.hidden ? `hidden ${col.hidden}:table-cell` : "",
                      // The tint has to live on the cells — that is where
                      // bg-secondary is, and a transition on the <tr> would never
                      // fire for it. Keep it OPAQUE.
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
  mobileCards: PropTypes.bool,
  renderMobileCard: PropTypes.func,
  mobileCardSurface: PropTypes.oneOf(["primary", "secondary"]),
  striped: PropTypes.bool,
};
