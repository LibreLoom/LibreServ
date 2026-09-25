import PropTypes from "prop-types";
import { Download, RefreshCw } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { formatAnswer, isAllowedUploadName, summarizeAnswers, typeInfo } from "./questionTypes.js";
import { responsesToCsv, uploadsDirPath } from "../../../lib/formDocument.js";
import { useFileSource } from "../../../lib/fileSource.jsx";
import { joinPath, pathBasename } from "../../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * The builder's Responses tab: a count, per-question summaries (bars for
 * choice-ish types, lists for text), an individual-answers table, and a
 * client-side CSV export of the sibling `.responses.jsonl`.
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
 *   onRefresh?: () => void,
 * }} props
 */
export default function FormResponses({
  driveId = "",
  formPath,
  questions,
  responses,
  loading = false,
  error = null,
  onRefresh,
}) {
  const source = useFileSource();
  function fileHref(name) {
    if (!driveId || typeof name !== "string" || !isAllowedUploadName(name)) return "";
    return source.contentHref(driveId, joinPath(uploadsDirPath(formPath), name));
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
    ...orphanIds.map((id) => ({ id, label: id, type: "", question: null })),
  ];

  function exportCsv() {
    haptic("light");
    const csv = responsesToCsv(columns, responses, (col, value) =>
      formatAnswer(col.question, value),
    );
    const stem = (pathBasename(formPath) || "form").replace(/\.lunaform$/i, "");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading answers">
        <div className="flex items-center gap-3 text-secondary">
          <p className="font-mono text-sm uppercase tracking-widest">Loading</p>
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
          {responses.length === 1 ? "1 answer" : `${responses.length} answers`}
        </h2>
        <div className="min-w-0 flex-1" />
        {onRefresh && (
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            aria-label="Reload answers"
            tooltip="Reload answers"
            onClick={() => {
              haptic("light");
              onRefresh();
            }}
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
          Export CSV
        </Button>
      </div>

      {responses.length === 0 ? (
        <EmptyState
          icon={Download}
          title="No answers yet"
          description="Share the form's answer link and responses will show up here."
        />
      ) : (
        <>
          {/* Per-question summaries */}
          <div className="space-y-3">
            {questions.map((question) => {
              const summary = summarizeAnswers(question, responses);
              const InfoIcon = typeInfo(question.type).icon;
              const max = summary.kind === "bars"
                ? Math.max(1, ...summary.rows.map((r) => r.count))
                : 0;
              return (
                <div
                  key={question.id}
                  className="rounded-large-element bg-primary text-secondary p-4 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <InfoIcon size={ICON_SIZE.sm} className="text-accent" aria-hidden="true" />
                    <p className="min-w-0 flex-1 truncate text-sm text-secondary">
                      {question.label || "Untitled question"}
                    </p>
                    <span className="font-mono text-xs text-accent">
                      {summary.answered} answered
                    </span>
                  </div>
                  {summary.kind === "number" ? (
                    <p className="text-sm text-secondary">Total {summary.total}</p>
                  ) : summary.kind === "bars" ? (
                    <div className="space-y-1.5">
                      {summary.rows.map((row) => (
                        <div key={row.label} className="flex items-center gap-2 text-sm">
                          <span className="w-32 shrink-0 truncate text-secondary">{row.label}</span>
                          <div className="h-2 min-w-0 flex-1 rounded-pill bg-secondary/20 overflow-hidden">
                            <div
                              className="h-full rounded-pill bg-accent motion-safe:transition-all motion-safe:duration-300"
                              style={{ width: `${Math.round((row.count / max) * 100)}%` }}
                            />
                          </div>
                          <span className="w-8 shrink-0 text-right font-mono text-xs text-secondary">
                            {row.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ul className="m-0 list-none space-y-1 p-0">
                      {summary.items.slice(0, 8).map((item, i) => (
                        <li key={i} className="truncate text-sm text-secondary">
                          {question.type === "file" && fileHref(item) ? (
                            <a href={fileHref(item)} className="text-secondary underline" target="_blank" rel="noreferrer">
                              {item}
                            </a>
                          ) : item}
                        </li>
                      ))}
                      {summary.items.length > 8 && (
                        <li className="text-xs text-accent">
                          and {summary.items.length - 8} more — see the table below
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* Individual answers */}
          <div className="overflow-x-auto rounded-large-element bg-primary text-secondary">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-secondary/15">
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-secondary">
                    Submitted
                  </th>
                  {columns.map((col) => (
                    <th
                      key={col.id}
                      className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-secondary"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {responses.map((rec) => (
                  <tr key={rec.id} className="border-b border-secondary/10 last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-2 text-secondary">
                      {Number(rec.at)
                        ? new Date(Number(rec.at) * 1000).toLocaleString()
                        : ""}
                    </td>
                    {columns.map((col) => (
                      <td key={col.id} className="max-w-64 truncate px-3 py-2 text-secondary">
                        <AnswerCell
                          question={col.question}
                          value={rec.answers?.[col.id]}
                          href={col.question?.type === "file" ? fileHref(rec.answers?.[col.id]) : ""}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function AnswerCell({ question, value, href }) {
  const text = formatAnswer(question, value);
  if (!text) return null;
  if (href) {
    return (
      <a href={href} className="text-secondary underline" target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  return text;
}

AnswerCell.propTypes = {
  question: PropTypes.object,
  value: PropTypes.any,
  href: PropTypes.string,
};

FormResponses.propTypes = {
  driveId: PropTypes.string,
  formPath: PropTypes.string.isRequired,
  questions: PropTypes.array.isRequired,
  responses: PropTypes.array.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRefresh: PropTypes.func,
};
