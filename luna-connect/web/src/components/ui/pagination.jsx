import { Button } from "./button.jsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Accessible, token-styled pagination controls following Simplex Mono.
 *
 * @param {Object} props
 * @param {number} props.page - Current 1-based page number
 * @param {number} props.pageSize - Number of items per page
 * @param {number} [props.total] - Total number of items
 * @param {boolean} [props.hasMore] - Whether there is a next page
 * @param {(newPage: number) => void} props.onPageChange - Handler for page change
 * @param {(newSize: number) => void} [props.onPageSizeChange] - Handler for page size change
 * @param {number[]} [props.pageSizeOptions] - List of page size options
 * @param {string} [props.itemLabel] - Label for items, e.g. "tokens", "accounts"
 * @param {boolean} [props.loading] - Whether data is currently loading
 * @param {string} [props.className] - Optional extra wrapper classes
 */
export function PaginationControls({
  page = 1,
  pageSize = 25,
  total,
  hasMore = false,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  itemLabel = "items",
  loading = false,
  className = "",
}) {
  const hasTotal = typeof total === "number";
  const totalPages = hasTotal ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = hasTotal ? Math.min(page * pageSize, total) : page * pageSize;
  const canPrev = page > 1 && !loading;
  const canNext = (hasTotal ? page < totalPages : hasMore) && !loading;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 pt-2 text-xs font-mono text-muted-foreground ${className}`}
      data-testid="pagination-controls"
    >
      <div className="flex items-center gap-3">
        <span>
          {hasTotal ? (
            total === 0 ? (
              `0 ${itemLabel}`
            ) : (
              `Showing ${start}–${end} of ${total} ${itemLabel}`
            )
          ) : (
            `Page ${page}`
          )}
        </span>

        {onPageSizeChange && pageSizeOptions?.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <label htmlFor="pagination-page-size" className="sr-only">
              Items per page
            </label>
            <select
              id="pagination-page-size"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              disabled={loading}
              aria-label="Items per page"
              className="h-7 rounded-pill border border-border bg-background px-2.5 text-xs font-mono text-foreground outline-none transition-colors hover:bg-accent/30 focus-visible:border-ring"
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt} / page
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasTotal && (
          <span className="mr-1 text-xs">
            Page {page} of {totalPages}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
