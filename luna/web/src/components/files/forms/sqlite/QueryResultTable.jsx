/**
 * Read-only result set for a SQL run, using the shared table shape.
 */

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { ChevronLeft, ChevronRight, Table2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import { TooltipTargets } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { GRID_PAGE_SIZE, formatCellValue, formatCount } from "./sqliteModel.js";

/**
 * @param {{ value: unknown }} props
 */
function ResultValue({ value }) {
  const formatted = formatCellValue(value);
  const muted = formatted.kind === "null" || formatted.kind === "empty";
  return (
    <span
      data-tooltip={formatted.title || undefined}
      className={
        formatted.kind === "number" || formatted.kind === "blob"
          ? "block max-w-[24rem] truncate tabular-nums"
          : `block max-w-[24rem] truncate${muted ? " italic" : ""}`
      }
    >
      {formatted.text}
    </span>
  );
}

ResultValue.propTypes = {
  value: PropTypes.any,
};

/**
 * @param {{
 *   result: {
 *     columns: string[],
 *     rows: any[][],
 *     rowCount: number,
 *     truncated: boolean,
 *   },
 * }} props
 */
export default function QueryResultTable({ result }) {
  const [position, setPosition] = useState({ result, page: 0 });
  const page = result === position.result ? position.page : 0;
  if (position.result !== result) setPosition({ result, page: 0 });
  const start = page * GRID_PAGE_SIZE;
  const end = Math.min(start + GRID_PAGE_SIZE, result.rows.length);
  const columns = useMemo(() => result.columns.map((name, index) => ({
    key: `c${index}`,
    label: name || `Column ${index + 1}`,
    render: (/** @type {any} */ row) => (
      <ResultValue value={row.values[index]} />
    ),
    noRowClick: true,
  })), [result.columns]);
  const data = useMemo(
    () => result.rows.slice(start, end).map((values, index) => ({ index: start + index, values })),
    [result.rows, start, end],
  );

  return (
    <TooltipTargets className="flex min-h-0 flex-1 flex-col gap-2">
      {result.truncated ? (
        <PageNotice variant="info" className="shrink-0">
          {result.rows.length === 0
            ? "This result is too large to show here. Add a filter or a LIMIT."
            : `Showing the first ${formatCount(result.rows.length)} rows. Add a filter or a LIMIT to see the rest.`}
        </PageNotice>
      ) : null}
      {result.rows.length > GRID_PAGE_SIZE && (
        <nav aria-label="Query result pages" className="flex shrink-0 items-center justify-end gap-2">
          <span className="text-xs" role="status">
            {formatCount(start + 1)}–{formatCount(end)} of {formatCount(result.rows.length)}
          </span>
          <Button
            variant="outline"
            surface="primary"
            size="iconSm"
            aria-label="Previous result page"
            disabled={start === 0}
            onClick={() => setPosition({ result, page: page - 1 })}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            variant="outline"
            surface="primary"
            size="iconSm"
            aria-label="Next result page"
            disabled={end === result.rows.length}
            onClick={() => setPosition({ result, page: page + 1 })}
          >
            <ChevronRight size={16} />
          </Button>
        </nav>
      )}
      {result.rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={Table2}
            title="No rows"
            description="The query returned no rows."
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <Table
            className="h-full min-h-0 min-w-max"
            columns={columns}
            data={data}
            rowKey="index"
            scrollable
            maxHeight="100%"
          />
        </div>
      )}
    </TooltipTargets>
  );
}

QueryResultTable.propTypes = {
  result: PropTypes.shape({
    columns: PropTypes.arrayOf(PropTypes.string).isRequired,
    rows: PropTypes.array.isRequired,
    rowCount: PropTypes.number,
    truncated: PropTypes.bool,
  }).isRequired,
};
