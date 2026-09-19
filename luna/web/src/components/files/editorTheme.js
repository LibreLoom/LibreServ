/**
 * CodeMirror theming for the file editor, in Simplex Mono tokens.
 *
 * Everything resolves through the CSS custom properties (`--primary`,
 * `--secondary`, `--accent`) so the editor follows light/dark with the rest
 * of the app — no hardcoded colors, no per-mode duplication.
 *
 * `editorBaseTheme` — shared chrome: transparent surface (the editing canvas
 *   carries no border or ring), caret/selection colors, search panel.
 * `sourceTheme` — raw Markdown mode: all-mono with restrained monochrome
 *   syntax highlighting (structure via accent + style, not a rainbow).
 * `previewTheme` — live-preview mode: body text sets in the reading font,
 *   formatted spans get real typography, marks dim or vanish (the
 *   decorations themselves live in markdownLivePreview.js — this file owns
 *   the classes they apply).
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const editorBaseTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--secondary)",
    height: "100%",
    fontSize: "0.925rem",
  },
  ".cm-scroller": {
    overflow: "auto",
    lineHeight: "1.75",
    fontFamily: "inherit",
  },
  ".cm-content": {
    padding: "1rem 1.25rem",
    caretColor: "var(--secondary)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--secondary)" },
  ".cm-cursor-primary": { borderLeftColor: "var(--secondary)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 50%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--secondary)",
    color: "var(--primary)",
    border: "none",
  },
  ".cm-panels input, .cm-panels button": {
    fontFamily: "var(--font-sans)",
    fontSize: "0.8rem",
  },
  ".cm-panels input": {
    backgroundColor: "var(--primary)",
    color: "var(--secondary)",
    border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
    borderRadius: "9999px",
    padding: "2px 10px",
    outline: "none",
  },
  ".cm-panels button": {
    backgroundImage: "none",
    backgroundColor: "transparent",
    color: "var(--primary)",
    border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)",
    borderRadius: "9999px",
    padding: "2px 10px",
    cursor: "pointer",
    textTransform: "none",
  },
  ".cm-panel.cm-search": {
    padding: "0.4rem 0.75rem",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--secondary)",
    color: "var(--primary)",
    border: "none",
    borderRadius: "12px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    color: "var(--primary)",
  },
  // Remote-collaborator cursors (y-codemirror.next). Colors arrive inline
  // from each peer's awareness state; we only set shape.
  ".cm-ySelectionCaret": {
    position: "relative",
    borderLeft: "2px solid",
    marginLeft: "-1px",
    padding: "0",
  },
  ".cm-ySelectionCaretDot": { display: "none" },
  ".cm-ySelectionInfo": {
    position: "absolute",
    top: "-1.4em",
    left: "-2px",
    fontFamily: "var(--font-sans)",
    fontSize: "0.65rem",
    lineHeight: "1.4",
    padding: "1px 7px",
    borderRadius: "9999px",
    color: "var(--primary)",
    opacity: "0",
    transition: "opacity 150ms",
    whiteSpace: "nowrap",
    zIndex: "20",
  },
  ".cm-ySelectionCaret:hover .cm-ySelectionInfo": { opacity: "1" },
});

/**
 * Live-preview typography. Applied on top of the base theme when the editor
 * is in Preview mode — the reading face takes over, and `cm-lp-*` classes
 * (added by the decoration plugin) carry the formatted look.
 */
export const previewTheme = EditorView.theme({
  // Only the reading face changes — size and line-height stay at the shared
  // base (0.925rem / 1.75) so flipping Write ↔ Source never reflows lines.
  ".cm-content": {
    fontFamily: "var(--font-sans)",
  },
  ".cm-lp-h1": { fontFamily: "var(--font-mono)", fontSize: "1.55em", lineHeight: "1.3" },
  ".cm-lp-h2": { fontFamily: "var(--font-mono)", fontSize: "1.3em", lineHeight: "1.35" },
  ".cm-lp-h3": { fontFamily: "var(--font-mono)", fontSize: "1.12em", lineHeight: "1.4" },
  ".cm-lp-h4, .cm-lp-h5, .cm-lp-h6": { fontFamily: "var(--font-mono)", fontSize: "1em" },
  ".cm-lp-bold": { fontWeight: "700" },
  ".cm-lp-italic": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through" },
  ".cm-lp-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)",
    borderRadius: "6px",
    padding: "0.1em 0.35em",
  },
  ".cm-lp-link": {
    color: "var(--accent)",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "3px",
  },
  ".cm-lp-quote": {
    borderLeft: "3px solid var(--accent)",
    paddingLeft: "0.9em",
    color: "var(--accent)",
  },
  ".cm-lp-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
  },
  ".cm-lp-dim": { color: "var(--accent)" },
  ".cm-lp-hr-line": {
    borderTop: "1px solid color-mix(in srgb, var(--secondary) 35%, transparent)",
    marginTop: "0.7em",
    marginBottom: "0.7em",
    height: "0",
    overflow: "hidden",
  },
  ".cm-lp-task": {
    appearance: "none",
    width: "0.95em",
    height: "0.95em",
    marginRight: "0.45em",
    verticalAlign: "-0.1em",
    border: "1.5px solid var(--accent)",
    borderRadius: "4px",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  ".cm-lp-task:checked": {
    backgroundColor: "var(--accent)",
    borderColor: "var(--accent)",
  },
  ".cm-lp-image": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4em",
    maxWidth: "100%",
    verticalAlign: "middle",
  },
  ".cm-lp-image img": {
    maxWidth: "min(420px, 100%)",
    maxHeight: "260px",
    borderRadius: "12px",
    display: "block",
  },
  ".cm-lp-image-broken": {
    fontFamily: "var(--font-sans)",
    fontSize: "0.8em",
    color: "var(--accent)",
    border: "1px dashed color-mix(in srgb, var(--accent) 50%, transparent)",
    borderRadius: "9999px",
    padding: "0.15em 0.7em",
  },
  // Editable table grid — a rounded card with inner hairlines, header layer,
  // and an always-visible controls strip along the bottom. Styling lives in
  // markdownTables.css (imported by MarkdownTableEditor.jsx) so the same
  // sheet reaches the portalled dialogs and expanded workspace; the grid
  // keeps the .cm-lp-table hook class for compatibility.
});

/**
 * Source mode: the raw document stays fully mono. Highlighting stays inside
 * the brand palette — accent for syntax marks and meta, secondary for
 * content, styles for emphasis. No color zoo.
 */
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--secondary)" },
  { tag: tags.processingInstruction, color: "var(--accent)" }, // `#`, `>`, `-`, marks
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, color: "var(--secondary)", textDecoration: "underline dotted" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, color: "var(--secondary)" },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline dotted" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.quote, color: "var(--accent)" },
  { tag: tags.comment, color: "var(--accent)" }, // code info strings, html
  { tag: tags.string, color: "var(--secondary)" },
  { tag: tags.keyword, color: "var(--accent)" },
  { tag: tags.atom, color: "var(--accent)" },
  { tag: tags.number, color: "var(--secondary)" },
]);

export const sourceTheme = EditorView.theme({
  ".cm-content": { fontFamily: "var(--font-mono)" },
});

export const sourceHighlighting = syntaxHighlighting(sourceHighlight);
