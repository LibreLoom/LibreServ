import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Bold, Code, Heading2, Italic, Link2, List } from "lucide-react";
import Button from "../ui/Button.jsx";
import ShakeTarget from "../ui/ShakeTarget.jsx";
import { ActionTooltipGroup, Tooltip } from "../ui/Tooltip.jsx";
import { applyMarkdownAction } from "../../lib/markdown.js";
import { ICON_SIZE } from "@/lib/ui-tokens";

/**
 * Toolbar actions — each inserts or toggles Markdown syntax around the
 * textarea selection. Labels are plain language; tooltips repeat the label.
 */
const TOOLBAR_ACTIONS = [
  { action: "bold", icon: Bold, label: "Bold" },
  { action: "italic", icon: Italic, label: "Italic" },
  { action: "code", icon: Code, label: "Code" },
  { action: "link", icon: Link2, label: "Link" },
  { action: "heading", icon: Heading2, label: "Heading" },
  { action: "list", icon: List, label: "List" },
];

/**
 * Markdown element → themed element. Mirrors the release-notes render in
 * SystemUpdatesCard: mono headings (Simplex Mono identity), accent links,
 * layered inverted code blocks. Container is bg-primary/text-secondary, so
 * body text inherits and only structure gets classes.
 */
const markdownComponents = {
  h1: (props) => <h1 className="mb-3 mt-0 font-mono text-3xl font-normal first:mt-0" {...props} />,
  h2: (props) => <h2 className="mb-3 mt-4 font-mono text-2xl font-normal first:mt-0" {...props} />,
  h3: (props) => <h3 className="mb-2 mt-3 font-mono text-xl font-normal first:mt-0" {...props} />,
  h4: (props) => <h4 className="mb-2 mt-3 font-mono text-lg font-normal first:mt-0" {...props} />,
  p: (props) => <p className="mb-3 last:mb-0" {...props} />,
  a: (props) => (
    <a className="link-accent" target="_blank" rel="noreferrer noopener" {...props} />
  ),
  ul: (props) => <ul className="mb-3 ml-4 list-inside list-disc last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-3 ml-4 list-inside list-decimal last:mb-0" {...props} />,
  li: (props) => <li className="mb-1" {...props} />,
  blockquote: (props) => (
    <blockquote className="mb-3 border-l-2 border-accent pl-4 last:mb-0" {...props} />
  ),
  hr: () => <hr className="my-4 border-secondary/30" />,
  code: (props) => (
    <code className="rounded bg-secondary/10 px-1.5 py-0.5 font-mono text-[0.85em]" {...props} />
  ),
  // Fenced/indented code gets a layered inverted block; neutralize the
  // inline-code pill on the nested <code>.
  pre: (props) => (
    <pre
      className="mb-3 overflow-x-auto rounded-large-element bg-secondary p-4 text-primary last:mb-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...props}
    />
  ),
  img: (props) => <img className="max-w-full rounded-large-element" {...props} />,
  table: (props) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-secondary/30 px-3 py-1.5 text-left font-mono font-normal" {...props} />
  ),
  td: (props) => <td className="border border-secondary/30 px-3 py-1.5" {...props} />,
  input: (props) => <input className="mr-1.5 align-middle" {...props} />,
};

/**
 * Markdown editing surface for .md/.markdown drive files.
 *
 * Edit keeps the plain textarea (plus a small syntax toolbar); Preview
 * renders the draft with react-markdown + rehype-sanitize — file content is
 * untrusted, so sanitization stays on. The Edit/Preview segmented control
 * lives in FileViewer's footer chrome, so `view` is controlled from there.
 * Saving is unchanged: FileViewer uploads `text` as before.
 *
 * @param {{
 *   text: string,
 *   onChange: (next: string) => void,
 *   name: string,
 *   canWrite?: boolean,
 *   view?: "edit" | "preview",
 *   error?: string | null,
 * }} props
 */
export default function MarkdownEditor({
  text,
  onChange,
  name,
  canWrite = true,
  view = "edit",
  error = null,
}) {
  const textareaRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const pendingSelectionRef = useRef(/** @type {{ start: number, end: number } | null} */ (null));

  // Restore the selection a toolbar action computed once React re-renders
  // the textarea with the new value.
  useEffect(() => {
    if (view !== "edit") return;
    const el = textareaRef.current;
    const sel = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    if (!el || !sel) return;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  }, [text, view]);

  /** @param {string} action */
  function applyAction(action) {
    const el = textareaRef.current;
    if (!el || !canWrite) return;
    const result = applyMarkdownAction(text, el.selectionStart, el.selectionEnd, action);
    pendingSelectionRef.current = { start: result.start, end: result.end };
    onChange(result.text);
  }

  if (view === "preview") {
    return (
      <div
        className="max-h-[65vh] min-h-[50vh] overflow-y-auto rounded-large-element border-2 border-secondary/30 bg-primary p-4 text-secondary"
        aria-label={`Preview of ${name}`}
      >
        {text.trim() ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={markdownComponents}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <p className="text-sm text-accent">
            Nothing to preview yet. Switch to Edit and start writing.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {canWrite && (
        <ActionTooltipGroup className="mb-2">
          <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Formatting">
            {TOOLBAR_ACTIONS.map(({ action, icon: Icon, label }) => (
              <Tooltip key={action} content={label}>
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={label}
                  onClick={() => applyAction(action)}
                >
                  <Icon size={ICON_SIZE.md} aria-hidden="true" />
                </Button>
              </Tooltip>
            ))}
          </div>
        </ActionTooltipGroup>
      )}
      <ShakeTarget shake={error}>
        <textarea
          ref={textareaRef}
          className="min-h-[50vh] w-full rounded-large-element border-2 border-secondary/30 bg-primary p-4 font-mono text-sm text-secondary outline-none focus:border-accent"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          readOnly={!canWrite}
          aria-label={`Contents of ${name}`}
        />
      </ShakeTarget>
    </div>
  );
}

MarkdownEditor.propTypes = {
  text: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  view: PropTypes.oneOf(["edit", "preview"]),
  error: PropTypes.string,
};
