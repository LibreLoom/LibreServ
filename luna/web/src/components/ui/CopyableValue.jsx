import { useState } from "react";
import Button from "./Button";
import { canUseClipboard, copyWithFeedback } from "../../lib/clipboard";
import { cn } from "../../lib/utils";

/**
 * Link / token / URL display with one-click copy on secure pages.
 *
 * On plain HTTP (LAN IP), one-click copy cannot work — we show the value in a
 * selectable field and tell the user to select and copy by hand. Never shows
 * a Copy button that fails silently or pretends success.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {string} [props.copyLabel="Copy"]
 * @param {string} [props.copiedLabel="Copied"]
 * @param {string} [props.ariaLabel]
 * @param {"primary"|"secondary"} [props.surface="secondary"] Backdrop the control sits on.
 * @param {string} [props.className]
 * @param {boolean} [props.multiline=false] Use a textarea for long values.
 */
export default function CopyableValue({
  value,
  copyLabel = "Copy",
  copiedLabel = "Copied",
  ariaLabel = "Value to copy",
  surface = "secondary",
  className,
  multiline = false,
}) {
  const [copied, setCopied] = useState(false);
  const secure = canUseClipboard();
  const text = value == null ? "" : String(value);

  const fieldClass =
    surface === "primary"
      ? "bg-secondary text-primary border-2 border-primary/20"
      : "bg-primary text-secondary border-2 border-secondary/30";
  const hintClass = surface === "primary" ? "text-secondary" : "text-primary";

  function selectAll(e) {
    e.target.select();
  }

  if (!secure) {
    return (
      <div className={cn("space-y-2", className)} data-slot="copyable-value">
        <p className={cn("text-sm", hintClass)}>
          Select the text below, then copy it. Automatic copy needs a secure
          connection, and this page does not have one yet.
        </p>
        {multiline ? (
          <textarea
            readOnly
            rows={3}
            className={cn(
              "w-full rounded-large-element px-4 py-2 text-sm font-mono break-all resize-y",
              fieldClass,
            )}
            value={text}
            onFocus={selectAll}
            aria-label={ariaLabel}
          />
        ) : (
          <input
            readOnly
            className={cn(
              "w-full rounded-pill px-4 py-2 text-sm font-mono",
              fieldClass,
            )}
            value={text}
            onFocus={selectAll}
            aria-label={ariaLabel}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        multiline ? "flex flex-col gap-2" : "flex flex-col sm:flex-row gap-2",
        className,
      )}
      data-slot="copyable-value"
    >
      {multiline ? (
        <textarea
          readOnly
          rows={3}
          className={cn(
            "w-full rounded-large-element px-4 py-2 text-sm font-mono break-all resize-y",
            fieldClass,
          )}
          value={text}
          onFocus={selectAll}
          aria-label={ariaLabel}
        />
      ) : (
        <input
          readOnly
          className={cn(
            "w-full min-w-0 rounded-pill px-4 py-2 text-sm font-mono",
            fieldClass,
          )}
          value={text}
          onFocus={selectAll}
          aria-label={ariaLabel}
        />
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        surface={surface}
        className="shrink-0"
        onClick={() => copyWithFeedback(text, setCopied)}
      >
        {copied ? copiedLabel : copyLabel}
      </Button>
    </div>
  );
}
