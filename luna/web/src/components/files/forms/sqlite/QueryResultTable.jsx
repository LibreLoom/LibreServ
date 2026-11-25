/**
 * Read-only result set for a SQL run, using the shared table shape.
 */

import PropTypes from "prop-types";
import { Table2 } from "lucide-react";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import { TooltipTargets } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { formatCellValue, formatCount } from "./sqliteModel.js";

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
  const columns = result.columns.map((name, index) => ({
    key: `c${index}`,
    label: name || `Column ${index + 1}`,
    render: (/** @type {any} */ row) => (
      <ResultValue value={row[`c${index}`]} />
    ),
    noRowClick: true,
  }));
  const data = result.rows.map((values, rowIndex) => {
    /** @type {Record<string, any>} */
    const row = { __row: rowIndex };
    values.forEach((value, index) => {
      row[`c${index}`] = value;
    });
    return row;
  });

  return (
    <TooltipTargets className="flex min-h-0 flex-1 flex-col gap-2">
      {result.truncated ? (
        <PageNotice variant="info" className="shrink-0">
          {result.rows.length === 0
            ? "This result is too large to show here. Add a filter or a LIMIT."
            : `Showing the first ${formatCount(result.rows.length)} rows. Add a filter or a LIMIT to see the rest.`}
        </PageNotice>
      ) : null}
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
            rowKey="__row"
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
