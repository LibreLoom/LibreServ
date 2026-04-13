import PropTypes from "prop-types";

const CELL_BASE = "py-2.5 bg-secondary group-hover:bg-primary/5 transition-colors";
const CELL_FIRST = "pl-3 rounded-l-large-element";
const CELL_LAST = "pr-3 rounded-r-large-element";
const CELL_MIDDLE = "px-1";

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

export default function Table({ columns, data, rowKey, scrollable, maxHeight, className = "" }) {
  const wrapperStyle = scrollable ? { maxHeight: maxHeight || "24rem" } : undefined;

  return (
    <div className={`bg-primary/5 rounded-card p-3 ${className}`}>
      <div className={scrollable ? "overflow-y-auto" : undefined} style={wrapperStyle}>
        <table className="w-full text-sm border-separate border-spacing-y-2">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`${ALIGN[col.align] || ALIGN.left} px-3 py-1.5 text-xs font-medium text-accent/70 ${col.hidden ? `hidden ${col.hidden}:table-cell` : ""} ${col.width || ""}`}
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
                <tr key={key} className="group transition-colors">
                  {columns.map((col, colIndex) => {
                    const isFirst = colIndex === 0;
                    const isLast = colIndex === columns.length - 1;
                    const cellClasses = [
                      CELL_BASE,
                      isFirst ? CELL_FIRST : "",
                      isLast ? CELL_LAST : "",
                      !isFirst && !isLast ? CELL_MIDDLE : "",
                      col.hidden ? `hidden ${col.hidden}:table-cell` : "",
                    ].filter(Boolean).join(" ");

                    const content = col.render
                      ? col.render(row, rowIndex)
                      : row[col.key];

                    return (
                      <td key={col.key} className={cellClasses}>
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
    })
  ).isRequired,
  data: PropTypes.array.isRequired,
  rowKey: PropTypes.string,
  scrollable: PropTypes.bool,
  maxHeight: PropTypes.string,
  className: PropTypes.string,
};