import { Fragment, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Info, TriangleAlert } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/**
 * One thing that needs the person's attention. `title` is a list of segments: a string is plain
 * text, `{ name }` wears an InlinePill. An item has `action.href` (a link button), `action.intent`
 * (a button the page handles), or no action.
 *
 * @typedef {{
 *   id: string,
 *   rank: number,
 *   tone: "problem" | "warning" | "info",
 *   title: Array<string | { name: string }>,
 *   detail?: string | Array<string | { name: string }>,
 *   hint?: string,
 *   action?: { label: string, ariaLabel?: string, href?: string, intent?: "open-backup" | "check-phrase", payload?: any },
 * }} NeedsYouItem
 */

/** Rows shown before the rest fold behind "Show N more". Items arrive most urgent first. */
const VISIBLE_LIMIT = 5;

/**
 * A row's title: plain text segments stay text, `{ name }` segments wear a pill.
 *
 * @param {{ segments: NeedsYouItem["title"], hint?: string }} props
 */
function Title({ segments, hint }) {
  return (
    <p className="font-mono text-base">
      {segments.map((segment, i) =>
        typeof segment === "string" ? (
          <Fragment key={i}>{segment}</Fragment>
        ) : (
          <InlinePill key={i}>{segment.name}</InlinePill>
        ),
      )}
      {hint && (
        <>
          {" "}
          <InfoHint content={hint} surface="primary" />
        </>
      )}
    </p>
  );
}

/**
 * The row's detail: a sentence, or segments where names wear a pill.
 *
 * @param {{ detail: NonNullable<NeedsYouItem["detail"]> }} props
 */
function Detail({ detail }) {
  return (
    <p className="text-xs">
      {typeof detail === "string"
        ? detail
        : detail.map((segment, i) =>
            typeof segment === "string" ? (
              <Fragment key={i}>{segment}</Fragment>
            ) : (
              <InlinePill key={i}>{segment.name}</InlinePill>
            ),
          )}
    </p>
  );
}

/**
 * The row's single button. A link when the fix lives on another page, a plain button when the
 * page handles it (a picker or a sheet). The row is a surface-primary panel, so the button
 * names that as its backdrop.
 *
 * @param {{ item: NeedsYouItem, onAction: (item: NeedsYouItem) => void }} props
 */
function RowAction({ item, onAction }) {
  const action = item.action;
  if (!action) return null;
  if (action.href) {
    return (
      <Button size="sm" variant="outline" surface="primary" asChild>
        <Link to={action.href} aria-label={action.ariaLabel}>
          {action.label}
        </Link>
      </Button>
    );
  }
  if (action.intent) {
    return (
      <Button
        size="sm"
        variant="outline"
        surface="primary"
        onClick={() => onAction?.(item)}
        aria-label={action.ariaLabel}
      >
        {action.label}
      </Button>
    );
  }
  return null;
}

/**
 * The dashboard's "Needs you" zone: a card of compact rows, most urgent first, each with a tone
 * icon, a title, an optional detail sentence and at most one button. Shows nothing when there
 * is nothing to do. Presentational only: the page decides what the items are and what the
 * intent buttons open.
 *
 * @param {{
 *   items?: NeedsYouItem[],
 *   onAction: (item: NeedsYouItem) => void,
 * }} props
 */
export default function NeedsYou({ items, onAction }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (!items || items.length === 0) return null;

  const hiddenCount = Math.max(0, items.length - VISIBLE_LIMIT);
  const visible = expanded ? items : items.slice(0, VISIBLE_LIMIT);

  return (
    <section aria-label="Needs you">
      <Card title="Needs you">
        <ul id={listId} className="flex flex-col gap-3">
          {visible.map((item) => {
            const Icon = item.tone === "info" ? Info : TriangleAlert;
            const iconTone =
              item.tone === "problem" ? "text-error" : item.tone === "warning" ? "text-warning" : "text-info";
            return (
              <li
                key={item.id}
                data-tone={item.tone}
                className="surface-primary rounded-large-element p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Icon
                    size={ICON_SIZE.lg}
                    className={cn("mt-0.5 shrink-0", iconTone)}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 space-y-1">
                    <Title segments={item.title} hint={item.hint} />
                    {item.detail && <Detail detail={item.detail} />}
                  </div>
                </div>
                {item.action && (
                  <div className="shrink-0">
                    <RowAction item={item} onAction={onAction} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {hiddenCount > 0 && (
          <div className="mt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls={listId}
            >
              {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
