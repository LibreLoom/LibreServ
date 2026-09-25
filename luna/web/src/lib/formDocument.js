/**
 * `.lunaform` documents and their sibling `<name>.responses.jsonl` files.
 *
 * The envelope is forward-compatible: `version` gates readers, unknown
 * fields are preserved on round-trip (the builder edits the parsed object
 * and serializes the whole thing back), and question/response records carry
 * their own `v` fields.
 */

export const FORM_DOC_VERSION = 1;
export const FORM_FILE_SUFFIX = ".lunaform";
export const RESPONSES_SUFFIX = ".responses.jsonl";

/** `rsvp.lunaform` → `rsvp.responses.jsonl` (same folder). */
export function responsesSiblingPath(formPath) {
  const path = String(formPath || "");
  const lower = path.toLowerCase();
  if (lower.endsWith(FORM_FILE_SUFFIX)) {
    return path.slice(0, path.length - FORM_FILE_SUFFIX.length) + RESPONSES_SUFFIX;
  }
  return path + RESPONSES_SUFFIX;
}

/** A fresh, valid v1 form document. */
export function blankFormDocument(title = "Untitled form") {
  return {
    version: FORM_DOC_VERSION,
    title,
    description: "",
    settings: {
      responseLimit: "unlimited",
      allowEdits: true,
      collecting: true,
    },
    questions: [],
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a `.lunaform` file. Empty files count as a brand-new form (the New
 * menu writes real content, but a user can also create an empty file by
 * hand). Unknown versions refuse to open with a plain-language error rather
 * than risk mangling a newer format.
 *
 * @param {string} text
 * @returns {{ ok: boolean, doc?: any, error?: string }}
 */
export function parseFormDocument(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: true, doc: blankFormDocument() };
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: "This file isn't a working Luna form. Open it as text to see what's inside.",
    };
  }
  if (!isObject(raw)) {
    return {
      ok: false,
      error: "This file isn't a working Luna form. Open it as text to see what's inside.",
    };
  }
  const version = Number(raw.version ?? 1);
  if (!Number.isFinite(version) || version > FORM_DOC_VERSION) {
    return {
      ok: false,
      error: "This form was made with a newer version of Luna. Update Luna to open it.",
    };
  }
  // Normalize only the fields Luna knows; everything else passes through so
  // a newer file's extras survive a save here.
  const doc = { ...raw, version };
  if (typeof doc.title !== "string") doc.title = "";
  if (typeof doc.description !== "string") doc.description = "";
  doc.settings = {
    responseLimit: "unlimited",
    allowEdits: true,
    collecting: true,
    ...(isObject(raw.settings) ? raw.settings : {}),
  };
  doc.questions = Array.isArray(raw.questions)
    ? raw.questions.filter(isObject)
    : [];
  return { ok: true, doc };
}

/** Serialize for saving — pretty JSON so the file stays hand-editable. */
export function serializeFormDocument(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable per-question id — answers key on this, never on position/label. */
export function newQuestionId() {
  return `q_${randomHex(3)}`;
}

/**
 * The per-response secret a respondent holds (cookie + edit link). Luna only
 * ever stores its hash on the drive.
 */
export function newEditToken() {
  const buf = new Uint8Array(18);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Parse a responses JSONL file. Bad lines are skipped — the file is
 * append-only and hand-inspectable, so a torn line shouldn't kill the rest.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseResponsesJsonl(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((rec) => isObject(rec) && typeof rec.id === "string" && rec.id);
}

/**
 * Latest record per response id — edits append a new line with the same id,
 * so the last line wins. Order follows first submission, not last edit.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function latestResponses(records) {
  const order = [];
  const byId = new Map();
  for (const rec of records) {
    if (!byId.has(rec.id)) order.push(rec.id);
    byId.set(rec.id, rec);
  }
  return order.map((id) => byId.get(id));
}

/** Count of unique responses in a JSONL payload (edits don't inflate it). */
export function countResponses(text) {
  return latestResponses(parseResponsesJsonl(text)).length;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Client-side CSV export of the responses file. Columns are every question
 * id seen in the data plus the form's current questions — a deleted question
 * keeps its column (keyed by id, so renames don't orphan data).
 *
 * @param {{ id: string, label: string }[]} columns
 * @param {object[]} responses latest-wins records
 * @param {(column: object, value: unknown) => string} formatValue
 * @returns {string}
 */
export function responsesToCsv(columns, responses, formatValue) {
  const header = ["Submitted", ...columns.map((c) => c.label)];
  const lines = [header.map(csvCell).join(",")];
  for (const rec of responses) {
    const at = Number(rec.at) ? new Date(Number(rec.at) * 1000).toISOString() : "";
    const answers = isObject(rec.answers) ? rec.answers : {};
    const cells = columns.map((col) => csvCell(formatValue(col, answers[col.id])));
    lines.push([csvCell(at), ...cells].join(","));
  }
  return `${lines.join("\n")}\n`;
}
