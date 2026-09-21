import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@libreloom/ui/lib/utils.js";

/**
 * Markdown element → themed element. Mono headings (Simplex Mono identity),
 * accent links, layered inverted code blocks. Container is expected to set
 * bg-primary/text-secondary, so body text inherits and only structure gets
 * classes.
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
 * Rendered Markdown for reading — used by the file viewer modal and the
 * editor's Read mode. Content is untrusted, so sanitization stays on.
 *
 * @param {{
 *   text: string,
 *   name: string,
 *   className?: string,
 *   emptyHint?: string,
 * }} props
 */
export default function MarkdownPreview({ text, name, className, emptyHint }) {
  return (
    <div
      className={cn("overflow-y-auto bg-primary p-4 text-secondary", className)}
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
        <p className="text-sm text-accent">{emptyHint || "Nothing here yet."}</p>
      )}
    </div>
  );
}

MarkdownPreview.propTypes = {
  text: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  className: PropTypes.string,
  emptyHint: PropTypes.string,
};
