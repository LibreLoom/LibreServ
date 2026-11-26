/**
 * CodeMirror 6 surface for the SQL pane.
 *
 * Deliberately not `basicSetup`: its default highlight style paints a
 * rainbow, and Simplex Mono keeps syntax muted (accent for structures, the
 * surface text color for values). The parent owns the SQL text only through
 * `onChange`; the view is uncontrolled so re-renders never move the cursor.
 */

import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  autocompletion,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { sql, SQLite } from "@codemirror/lang-sql";
import { editorBaseTheme } from "../../editorTheme.js";

const sqlTheme = EditorView.theme({
  "&": { fontSize: "0.9rem" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "0.7rem 0.9rem",
    minHeight: "100%",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--accent)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 6px 0 4px",
    minWidth: "2.25rem",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--secondary)",
  },
  ".cm-placeholder": {
    color: "var(--accent)",
    fontStyle: "italic",
  },
});

const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)" },
  { tag: tags.operator, color: "var(--accent)" },
  { tag: tags.typeName, color: "var(--accent)" },
  { tag: [tags.bool, tags.null], color: "var(--accent)" },
  { tag: tags.comment, color: "var(--accent)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--secondary)" },
  { tag: tags.number, color: "var(--secondary)" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--secondary)" },
  { tag: tags.function(tags.variableName), color: "var(--secondary)" },
  { tag: tags.punctuation, color: "var(--secondary)" },
]);

/** @param {Record<string, string[]> | null | undefined} schema */
function sqlLanguage(schema) {
  return sql({
    dialect: SQLite,
    schema: schema || undefined,
    upperCaseKeywords: true,
  });
}

/**
 * @param {{
 *   schema?: Record<string, string[]> | null,
 *   initialSql?: string,
 *   onChange?: (doc: import("@codemirror/state").Text) => void,
 *   onRun?: () => void,
 * }} props
 */
export default function SqlEditor({
  schema = null,
  initialSql = "",
  onChange,
  onRun,
}) {
  const hostRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const viewRef = useRef(/** @type {EditorView|null} */ (null));
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const initialRef = useRef(initialSql);
  const schemaRef = useRef(schema);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  schemaRef.current = schema;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialRef.current,
        extensions: [
          editorBaseTheme,
          sqlTheme,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(sqlHighlight),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          languageCompartment.current.of(sqlLanguage(schemaRef.current)),
          placeholder("SELECT * FROM responses LIMIT 100;"),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  onRunRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          EditorView.contentAttributes.of({
            "aria-label": "SQL",
            spellcheck: "false",
            autocapitalize: "off",
            autocomplete: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            onChangeRef.current?.(update.state.doc);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.current.reconfigure(sqlLanguage(schema)),
    });
  }, [schema]);

  return (
    <div
      ref={hostRef}
      data-slot="sql-editor"
      className="h-full min-h-0 overflow-hidden"
    />
  );
}

SqlEditor.propTypes = {
  schema: PropTypes.object,
  initialSql: PropTypes.string,
  onChange: PropTypes.func,
  onRun: PropTypes.func,
};
