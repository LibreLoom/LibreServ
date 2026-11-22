import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { motion as Motion } from "motion/react";
import { ChevronLeft, ChevronRight, Database, Download, Inbox, RefreshCw, Trash2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { answerOptions, formatAnswer, isAllowedUploadName, typeInfo } from "./questionTypes.js";
import { apiErrorMessage } from "../../../lib/api.js";
import { responseSentAt, responsesToCsv } from "../../../lib/formDocument.js";
import { useFileSource } from "../../../lib/fileSource.jsx";
import { pathBasename } from "../../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/** @typedef {import("./questionTypes.js").FormQuestion} FormQuestion */
/** @typedef {import("../../../lib/formDocument.js").FormResponse} FormResponse */
/** @typedef {import("../../../lib/fileSource.jsx").FormSummary} FormSummary */
/** @typedef {import("../../../lib/fileSource.jsx").FormSummaryQuestion} FormSummaryQuestion */

/**
 * A table column: a current question, or a removed one that still has answers.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   type: string,
 *   question: FormQuestion | null,
 * }} ResponseColumn
 */

/**
 * The builder's Responses tab: a server-paged table where a row opens every
 * answer in full, per-question totals from the summary route, and a CSV
 * download built by the server. Only one page is in the browser at a time,
 * so a form with tens of thousands of answers opens as fast as a small one.
 *
 * Deleted questions keep their column — answers key on question id, so a
 * label rename never orphans data.
 *
 * @param {{
 *   driveId?: string,
 *   formPath: string,
 *   questions: FormQuestion[],
 *   responses: FormResponse[],
 *   total?: number,
 *   offset?: number,
 *   pageSize?: number,
 *   nextOffset?: number | null,
 *   summary?: FormSummary | null,
 *   summaryLoading?: boolean,
 *   notice?: string,
 *   loading?: boolean,
 *   paging?: boolean,
 *   error?: string | null,
 *   canDelete?: boolean,
 *   canOpenDatabase?: boolean,
 *   openingDatabase?: boolean,
 *   onOpenDatabase?: () => void,
 *   onPageChange?: (offset: number) => void,
 *   onRefresh?: () => void,
 *   onDeleteResponse?: (id: string) => Promise<unknown>,
 * }} props
 */
export default function FormResponses({
  driveId = "",
  formPath,
  questions,
  responses,
  total = 0,
  offset = 0,
  pageSize = 100,
  nextOffset = null,
  summary = null,
  summaryLoading = false,
  notice = "",
  loading = false,
  paging = false,
  error = null,
  canDelete = false,
  canOpenDatabase = false,
  openingDatabase = false,
  onOpenDatabase,
  onPageChange,
  onRefresh,
  onDeleteResponse,
}) {
  const source = useFileSource();
  const { addToast } = useToast();
  const [openId, setOpenId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  function fileHref(name) {
    if (!driveId || typeof name !== "string" || !isAllowedUploadName(name)) return "";
    return source.formFileHref(driveId, formPath, name);
  }

  // Deleted questions keep a column even when their last answer sits on a
  // page that isn't loaded — the summary knows every answered id.
  const knownIds = new Set(questions.map((q) => q.id));
  /** @type {string[]} */
  const orphanIds = [];
  for (const entry of summary?.questions || []) {
    if (!knownIds.has(entry.id) && !orphanIds.includes(entry.id)) orphanIds.push(entry.id);
  }
  for (const rec of responses) {
    const answers = rec && typeof rec.answers === "object" ? rec.answers : null;
    for (const id of Object.keys(answers || {})) {
      if (!knownIds.has(id) && !orphanIds.includes(id)) orphanIds.push(id);
    }
  }
  /** @type {ResponseColumn[]} */
  const columns = [
    ...questions.map((q) => ({
      id: q.id,
      label: q.label || "Untitled question",
      type: q.type,
      question: q,
    })),
    ...orphanIds.map((id, i) => ({
      id,
      label: orphanIds.length === 1 ? "Removed question" : `Removed question ${i + 1}`,
      type: "",
      question: null,
    })),
  ];
  const summaryById = new Map(
    (summary?.questions || []).map((entry) => [entry.id, entry]),
  );
  const openResponse = responses.find((r) => r.id === openId) || null;

  // Deleting the last row on a page leaves an offset past the end. Step back
  // once the new total arrives instead of showing an empty table.
  useEffect(() => {
    if (loading || paging || total <= 0 || offset <= 0 || responses.length > 0) return;
    onPageChange?.(Math.max(0, offset - pageSize));
  }, [loading, paging, total, offset, pageSize, responses.length, onPageChange]);

  const stem = (pathBasename(formPath) || "form").replace(/\.lunaform$/i, "");
  const exportHref =
    typeof source.formExportUrl === "function" ? source.formExportUrl(driveId, formPath) : "";
  // A source without a server export route still needs a way out: download
  // the rows already loaded, and say so when that isn't everything.
  const partialExport = !exportHref && responses.length < total;

  function exportCsv() {
    const csv = responsesToCsv(columns, responses, (col, value) =>
      formatAnswer(/** @type {ResponseColumn} */ (col).question, value, "\n"),
    );
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}-responses.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Firefox starts the download after the click returns; revoking in the
    // same tick can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    addToast({
      type: "success",
      message: partialExport ? "Page downloaded" : "CSV downloaded",
      description: "Open it with a spreadsheet app like LibreOffice Calc, Excel, or Numbers.",
    });
  }

  async function deleteOpen() {
    if (!openResponse || !onDeleteResponse) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDeleteResponse(openResponse.id);
      setConfirmDelete(false);
      setOpenId("");
      addToast({ type: "success", message: "Response deleted" });
    } catch (err) {
      setConfirmDelete(false);
      setDeleteError(apiErrorMessage(err, "Luna couldn't delete that response. Reload the page and try again."));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center" role="status" aria-label="Loading answers">
        <div className="flex items-center gap-3 text-secondary">
          <p className="font-mono text-sm">Loading…</p>
          <Spinner size="md" decorative />
        </div>
      </div>
    );
  }

  const firstShown = total > 0 ? Math.min(offset + 1, total) : 0;
  const lastShown = Math.min(offset + responses.length, total);
  const fallbackNext = lastShown < total ? lastShown : null;
  const nextPage = typeof nextOffset === "number" ? nextOffset : fallbackNext;
  const hasNext = typeof nextPage === "number" && nextPage > offset;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      {error && <PageNotice variant="error">{error}</PageNotice>}
      {notice && <PageNotice variant="warning">{notice}</PageNotice>}

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-lg text-secondary">
          {error && total === 0
            ? "Responses"
            : total === 1
              ? "1 response"
              : `${formatCount(total)} responses`}
        </h2>
        <div className="min-w-0 flex-1" />
        {onRefresh && (
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            aria-label="Reload answers"
            tooltip="Reload answers"
            onClick={onRefresh}
          >
            <RefreshCw size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        )}
        {canOpenDatabase && onOpenDatabase ? (
          <Button
            variant="outline"
            surface="primary"
            size="sm"
            disabled={openingDatabase}
            onClick={onOpenDatabase}
          >
            <Database size={ICON_SIZE.sm} aria-hidden="true" />
            {openingDatabase ? "Opening…" : "Open database"}
          </Button>
        ) : null}
        {total === 0 ? (
          <Button variant="outline" surface="primary" size="sm" disabled>
            <Download size={ICON_SIZE.sm} aria-hidden="true" />
            Download CSV
          </Button>
        ) : exportHref ? (
          <Button asChild variant="outline" surface="primary" size="sm">
            <a href={exportHref} download={`${stem}-responses.csv`}>
              <Download size={ICON_SIZE.sm} aria-hidden="true" />
              Download CSV
            </a>
          </Button>
        ) : (
          <Button variant="outline" surface="primary" size="sm" onClick={exportCsv}>
            <Download size={ICON_SIZE.sm} aria-hidden="true" />
            {partialExport ? "Download this page (CSV)" : "Download CSV"}
          </Button>
        )}
      </div>

      {total === 0 ? (
        error ? null : (
          <EmptyState
            icon={Inbox}
            title="No responses yet"
            description="Share a link to the form. Responses show here when people send them."
          />
        )
      ) : (
        <>
          {/* Per-question summaries — totals from the whole answers file,
              never from just the page on screen. */}
          <div className="space-y-3">
            {questions.map((question) => {
              // The summary only lists questions that have answers; show the
              // rest as zero once it has loaded.
              const entry =
                summaryById.get(question.id) ||
                (summary ? { id: question.id, answered: 0, values: [] } : null);
              const info = typeInfo(question.type);
              const InfoIcon = info.icon;
              return (
                <div
                  key={question.id}
                  className="rounded-large-element surface-secondary p-4 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <InfoIcon size={ICON_SIZE.sm} aria-hidden="true" />
                    <p className="min-w-0 flex-1 truncate text-sm text-primary">
                      {question.label || "Untitled question"}
                    </p>
                    <span className="font-mono text-xs">
                      {entry
                        ? `${formatCount(entry.answered)} answered`
                        : summaryLoading
                          ? "Loading…"
                          : ""}
                    </span>
                  </div>
                  {info.summary === "number" ? (
                    <NumberSummary entry={entry} />
                  ) : info.summary === "bars" ? (
                    <BarSummary question={question} entry={entry} />
                  ) : (
                    <p className="text-sm">
                      {entry && entry.answered === 0
                        ? "No answers yet."
                        : "Answers are in the table below."}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Individual responses — a row opens every answer in full. The
              pager sits above the rows so a phone doesn't scroll a whole page
              of cards before it can move on. */}
          <nav
            aria-label="Response pages"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <p className="text-sm text-secondary">
              {total > 0
                ? `Showing ${formatCount(firstShown)}–${formatCount(lastShown)} of ${formatCount(total)}`
                : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                surface="primary"
                size="sm"
                disabled={offset === 0 || paging}
                onClick={() => onPageChange?.(Math.max(0, offset - pageSize))}
              >
                <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />
                Previous page
              </Button>
              <Button
                variant="outline"
                surface="primary"
                size="sm"
                disabled={!hasNext || paging}
                onClick={() => {
                  if (typeof nextPage === "number") onPageChange?.(nextPage);
                }}
              >
                Next page
                <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </div>
          </nav>

          <div className="overflow-x-auto">
            <Table
              rowKey="id"
              mobileCards
              data={responses}
              onRowClick={(rec) => {
                setDeleteError("");
                setOpenId(rec.id);
              }}
              columns={[
                {
                  key: "sent",
                  label: "Sent",
                  render: (rec) => <span className="whitespace-nowrap">{formatSent(rec)}</span>,
                },
                ...columns.map((col) => ({
                  key: col.id,
                  label: col.label,
                  render: (rec) => (
                    <span className="block max-w-64 truncate">
                      {formatAnswer(col.question, rec.answers?.[col.id])}
                    </span>
                  ),
                })),
              ]}
            />
          </div>
        </>
      )}

      <ModalCard
        open={openResponse != null}
        title="Response"
        onClose={() => setOpenId("")}
        overlayClassName={NESTED_OVERLAY_CLASS}
      >
        {openResponse ? (
          <div className="space-y-4">
            <p className="text-sm text-primary">
              Sent {formatSent(openResponse)}
              {Number(openResponse.at) > responseSentAt(openResponse)
                ? ` · changed ${formatTime(Number(openResponse.at))}`
                : ""}
            </p>
            <dl className="max-h-[60vh] space-y-3 overflow-y-auto">
              {columns.map((col) => {
                const value = openResponse.answers?.[col.id];
                const text = formatAnswer(col.question, value);
                const href = col.question?.type === "file" ? fileHref(value) : "";
                return (
                  <div key={col.id} className="rounded-large-element surface-primary p-3">
                    <dt className="font-mono text-xs font-normal text-secondary">
                      {col.label}
                    </dt>
                    <dd className={cn("mt-1 whitespace-pre-wrap break-words text-sm", "text-secondary")}>
                      {href ? (
                        <a href={href} className="text-secondary underline" target="_blank" rel="noreferrer">
                          Open the attached file
                        </a>
                      ) : text || "No answer"}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <ModalErrorText error={deleteError} />
            {canDelete && onDeleteResponse ? (
              <div className="flex justify-end">
                <Button
                  variant="danger"
                  surface="secondary"
                  size="sm"
                  // The confirm prompt buzzes as it opens.
                  haptic={false}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
                  Delete this response
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </ModalCard>

      <ConfirmModal
        open={confirmDelete}
        variant="danger"
        title="Delete this response?"
        message="Luna removes it from the results and the CSV, and deletes its attached files. You can't undo this."
        confirmLabel="Delete"
        loading={deleting}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => !deleting && setConfirmDelete(false)}
        onConfirm={deleteOpen}
      />
    </div>
  );
}

FormResponses.propTypes = {
  driveId: PropTypes.string,
  formPath: PropTypes.string.isRequired,
  questions: PropTypes.array.isRequired,
  responses: PropTypes.array.isRequired,
  total: PropTypes.number,
  offset: PropTypes.number,
  pageSize: PropTypes.number,
  nextOffset: PropTypes.number,
  summary: PropTypes.object,
  summaryLoading: PropTypes.bool,
  notice: PropTypes.string,
  loading: PropTypes.bool,
  paging: PropTypes.bool,
  error: PropTypes.string,
  canDelete: PropTypes.bool,
  onPageChange: PropTypes.func,
  canOpenDatabase: PropTypes.bool,
  openingDatabase: PropTypes.bool,
  onOpenDatabase: PropTypes.func,
  onRefresh: PropTypes.func,
  onDeleteResponse: PropTypes.func,
};

/**
 * Total and average for a number question, from the summary's value counts.
 * @param {{ entry: FormSummaryQuestion | null }} props
 */
function NumberSummary({ entry }) {
  if (!entry) return null;
  let total = 0;
  let answers = 0;
  for (const item of entry.values) {
    if (item.value == null || (typeof item.value === "string" && item.value.trim() === "")) continue;
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    if (!Number.isFinite(value)) continue;
    total += value * item.count;
    answers += item.count;
  }
  return (
    <p className="text-sm text-primary">
      Total {formatNumber(total)}
      {answers > 0 ? ` · average ${formatNumber(total / answers)}` : ""}
    </p>
  );
}

NumberSummary.propTypes = { entry: PropTypes.object };

/**
 * Bars for choice-ish questions. Every option the question offers keeps its
 * row even at zero; values outside the current option list still show so
 * removed options don't lose their answers.
 *
 * @param {{ question: FormQuestion, entry: FormSummaryQuestion | null }} props
 */
function BarSummary({ question, entry }) {
  if (!entry) return null;
  const rows = new Map();
  for (const option of answerOptions(question)) rows.set(option, 0);
  for (const item of entry.values) {
    const picks = Array.isArray(item.value)
      ? item.value
      : item.value == null || (typeof item.value === "string" && item.value.trim() === "")
        ? []
        : [item.value];
    for (const pick of picks) {
      const label = formatAnswer(question, pick) || "(blank)";
      rows.set(label, (rows.get(label) || 0) + item.count);
    }
  }
  return (
    <div className="space-y-1.5">
      {[...rows.entries()].map(([label, count]) => {
        // Share of people who answered this question. With checkboxes the
        // shares can add up past 100%.
        const share = entry.answered ? count / entry.answered : 0;
        return (
          <div key={label} className="flex items-center gap-2 text-sm">
            <span className="w-32 shrink-0 truncate text-primary" title={label}>{label}</span>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-pill surface-primary p-px">
              <Motion.div
                className="h-full rounded-pill surface-secondary"
                initial={{ width: 0 }}
                animate={{ width: `${Math.round(share * 100)}%` }}
                transition={{ type: "spring", stiffness: 180, damping: 26 }}
              />
            </div>
            <span className="w-20 shrink-0 text-right font-mono text-xs font-normal text-primary">
              {formatCount(count)} · {Math.round(share * 100)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

BarSummary.propTypes = {
  question: PropTypes.object.isRequired,
  entry: PropTypes.object,
};

/** Inline error inside the open response — the modal owns it, no toast. */
function ModalErrorText({ error }) {
  if (!error) return null;
  return <PageNotice variant="error">{error}</PageNotice>;
}

ModalErrorText.propTypes = { error: PropTypes.string };

function formatTime(unix) {
  return unix ? new Date(unix * 1000).toLocaleString() : "";
}

function formatSent(rec) {
  return formatTime(responseSentAt(rec)) || "earlier";
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function formatCount(n) {
  return Number(n).toLocaleString();
}
