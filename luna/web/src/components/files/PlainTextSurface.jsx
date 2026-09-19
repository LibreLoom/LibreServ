import PropTypes from "prop-types";
import { useFileEditor } from "./useFileEditor.js";
import { cn } from "@/lib/utils";

/**
 * Plain-text editing surface — the same CodeMirror + shared-document
 * binding as MarkdownEditor, without the Markdown machinery. Collab works
 * here too: two people editing the same .txt see each other live.
 *
 * @param {{
 *   sync: import("./collabDocSync.js").CollabDocSync,
 *   name: string,
 *   canWrite?: boolean,
 *   fill?: boolean,
 *   onStats?: (stats: { line: number, col: number, words: number }) => void,
 * }} props
 */
export default function PlainTextSurface({ sync, name, canWrite = true, fill = false, onStats }) {
  const { attachHost } = useFileEditor({
    ytext: sync.ytext,
    awareness: sync.awareness,
    canWrite,
    markdown: false,
    livePreview: false,
    ariaLabel: `Contents of ${name}`,
    onStats,
  });
  return (
    <div
      ref={attachHost}
      data-slot="text-editor-surface"
      className={cn("h-full min-h-0 overflow-hidden font-mono text-sm", !fill && "min-h-[50vh]")}
    />
  );
}

PlainTextSurface.propTypes = {
  sync: PropTypes.object.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  fill: PropTypes.bool,
  onStats: PropTypes.func,
};
