import { useState } from "react";
import PropTypes from "prop-types";
import { motion as Motion } from "motion/react";
import { Download, Inbox, RefreshCw, Trash2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { formatAnswer, isAllowedUploadName, summarizeAnswers, typeInfo } from "./questionTypes.js";
import { apiErrorMessage } from "../../../lib/api.js";
import { responseSentAt, responsesToCsv } from "../../../lib/formDocument.js";
import { useFileSource } from "../../../lib/fileSource.jsx";
import { pathBasename } from "../../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/** Summaries list this many text answers before pointing at the table. */
const SUMMARY_ITEMS = 8;

/**
 * The builder's Responses tab: a count, per-question summaries (bars for
 * choice-ish types, lists for text), an individual-responses table where a
 * row opens every answer in full, and a client-side CSV export.
 *
 * Deleted questions keep their column — answers key on question id, so a
 * label rename never orphans data.
 *
 * @param {{
 *   driveId?: string,
 *   formPath: string,
 *   questions: object[],
 *   responses: object[],
 *   loading?: boolean,
 *   error?: string | null,
 *   canDelete?: boolean,
 *   onRefresh?: () => void,
 *   onDeleteResponse?: (id: string) => Promise<unknown>,
 * }} props
 */
export default function FormResponses({
  driveId = "",
  formPath,
  questions,
  responses,
  loading = false,
  error = null,
  canDelete = false,
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
  // Columns: current questions in order, then any answered ids that no
  // longer have a question (deleted ones keep their data visible).
  const knownIds = new Set(questions.map((q) => q.id));
  const orphanIds = [];
  for (const rec of responses) {
    const answers = rec && typeof rec.answers === "object" ? rec.answers : null;
    for (const id of Object.keys(answers || {})) {
      if (!knownIds.has(id) && !orphanIds.includes(id)) orphanIds.push(id);
    }
  }
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
  const openResponse = responses.find((r) => r.id === openId) || null;

  function exportCsv() {
    const csv = responsesToCsv(columns, responses, (col, value) =>
      formatAnswer(col.question, value, "\n"),
    );
    const stem = (pathBasename(formPath) || "form").replace(/\.lunaform$/i, "");
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
      message: "CSV downloaded",
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

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      {error && <PageNotice variant="error">{error}</PageNotice>}

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-lg text-secondary">
          {responses.length === 1 ? "1 response" : `${responses.length} responses`}
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
        <Button
          variant="outline"
          surface="primary"
          size="sm"
          disabled={responses.length === 0}
          onClick={exportCsv}
        >
          <Download size={ICON_SIZE.sm} aria-hidden="true" />
          Download CSV
        </Button>
      </div>

      {responses.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No responses yet"
          description="Share the form's answer link and responses show up here as people send them."
        />
      ) : (
        <>
          {/* Per-question summaries */}
          <div className="space-y-3">
            {questions.map((question) => {
              const summary = summarizeAnswers(question, responses);
              const InfoIcon = typeInfo(question.type).icon;
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
                      {summary.answered} answered
                    </span>
                  </div>
                  {summary.kind === "number" ? (
                    <p className="text-sm text-primary">
                      Total {summary.total}
                      {summary.count > 0 ? ` · average ${formatNumber(summary.total / summary.count)}` : ""}
                    </p>
                  ) : summary.kind === "bars" ? (
                    <div className="space-y-1.5">
                      {summary.rows.map((row) => {
                        // Share of people who answered this question. With
                        // checkboxes the shares can add up past 100%.
                        const share = summary.answered ? row.count / summary.answered : 0;
                        return (
                          <div key={row.label} className="flex items-center gap-2 text-sm">
                            <span className="w-32 shrink-0 truncate text-primary" title={row.label}>{row.label}</span>
                            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-pill surface-primary p-px">
                              <Motion.div
                                className="h-full rounded-pill surface-secondary"
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.round(share * 100)}%` }}
                                transition={{ type: "spring", stiffness: 180, damping: 26 }}
                              />
                            </div>
                            <span className="w-20 shrink-0 text-right font-mono text-xs font-normal text-primary">
                              {row.count} · {Math.round(share * 100)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <ul className="m-0 list-none space-y-1 p-0">
                      {summary.items.slice(0, SUMMARY_ITEMS).map((item, i) => (
                        <li key={i} className="truncate text-sm text-primary" title={item}>
                          {question.type === "file" && fileHref(item) ? (
                            <a href={fileHref(item)} className="text-primary underline" target="_blank" rel="noreferrer">
                              {item}
                            </a>
                          ) : item}
                        </li>
                      ))}
                      {summary.items.length > SUMMARY_ITEMS && (
                        <li className="text-xs">
                          and {summary.items.length - SUMMARY_ITEMS} more — open a response below to read it in full
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* Individual responses — a row opens every answer in full. */}
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
        message="It disappears from the results and the CSV. This can't be undone."
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
  loading: PropTypes.bool,
  error: PropTypes.string,
  canDelete: PropTypes.bool,
  onRefresh: PropTypes.func,
  onDeleteResponse: PropTypes.func,
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
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
