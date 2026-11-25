/**
 * `.lunaform` documents and their sibling SQLite answers sidecars.
 *
 * The envelope is forward-compatible: `version` gates readers, unknown
 * fields are preserved on round-trip (the builder edits the parsed object
 * and serializes the whole thing back), and question/response records carry
 * their own `v` fields.
 */

export const FORM_DOC_VERSION = 1;
export const FORM_FILE_SUFFIX = ".lunaform";
export const RESPONSES_SUFFIX = ".lunaform.responses.sqlite";

/** `forms/rsvp.lunaform` → `forms/.rsvp.lunaform.responses.sqlite`. */
export function responsesSiblingPath(formPath) {
  const path = String(formPath || "");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const stem = name.toLowerCase().endsWith(FORM_FILE_SUFFIX)
    ? name.slice(0, name.length - FORM_FILE_SUFFIX.length)
    : name;
  return `${dir}.${stem}${RESPONSES_SUFFIX}`;
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
      thankYou: "",
      closeOn: "",
      maxResponses: null,
    },
    questions: [],
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * One stored response — a line in the responses JSONL, latest-wins. `at` is
 * when it was last written; `sent_at` when it was first sent (edits keep it).
 * Fields are optional because the file comes off the drive: a newer Luna may
 * write fields this version doesn't know, and a torn line is skipped whole.
 *
 * @typedef {{
 *   id?: string,
 *   at?: number,
 *   sent_at?: number,
 *   deleted?: boolean,
 *   edit_token?: string,
 *   answers?: Record<string, unknown>,
 * }} FormResponse
 */

const SETTING_DEFAULTS = {
  responseLimit: "unlimited",
  allowEdits: true,
  collecting: true,
  thankYou: "",
  closeOn: "",
  maxResponses: null,
};

/**
 * Settings in a stable shape. Missing keys get the defaults (old forms
 * predate them). Unknown keys stay, ahead of the known ones, so a newer
 * Luna's flags survive a save.
 * @param {unknown} raw
 */
export function canonicalSettings(raw) {
  const src = isObject(raw) ? raw : {};
  const known = new Set(Object.keys(SETTING_DEFAULTS));
  /** @type {Record<string, unknown>} */
  const extras = {};
  for (const [key, value] of Object.entries(src)) {
    if (!known.has(key)) extras[key] = value;
  }
  const max = src.maxResponses;
  return {
    ...extras,
    responseLimit: src.responseLimit === "one" ? "one" : "unlimited",
    allowEdits: src.allowEdits !== false,
    collecting: src.collecting !== false,
    thankYou: typeof src.thankYou === "string" ? src.thankYou : "",
    closeOn: typeof src.closeOn === "string" ? src.closeOn : "",
    maxResponses: typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : null,
  };
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
      error: "This file isn't a working Luna form.",
    };
  }
  if (!isObject(raw)) {
    return {
      ok: false,
      error: "This file isn't a working Luna form.",
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
  const doc = /** @type {Record<string, unknown>} */ ({ ...raw, version });
  if (typeof doc.title !== "string") doc.title = "";
  if (typeof doc.description !== "string") doc.description = "";
  doc.settings = canonicalSettings(raw.settings);
  doc.questions = Array.isArray(raw.questions)
    ? raw.questions.filter(isObject)
    : [];
  return { ok: true, doc };
}

/** Serialize for saving — pretty JSON so the file stays hand-editable. */
export function serializeFormDocument(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function seenKey(scope, path) {
  return `lunaform_seen:${scope}:${path}`;
}

/** How many answers the owner last looked at, for the "new" badge. */
export function readFormSeen(scope, path) {
  try {
    const n = Number(localStorage.getItem(seenKey(scope, path)));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** @param {string} scope @param {string} path @param {number} count */
export function writeFormSeen(scope, path, count) {
  try {
    localStorage.setItem(seenKey(scope, path), String(count));
  } catch {
    // private browsing — the badge just won't remember
  }
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
 * Latest live record per response id. The server already sends one row per
 * response; this keeps a merged or older payload in first-sent order and
 * drops a deleted record if one appears.
 *
 * @param {FormResponse[]} records
 * @returns {FormResponse[]}
 */
export function latestResponses(records) {
  const order = [];
  // `seen` keeps the first-send order lookup O(1); an id that is deleted and
  // later sent again keeps its original slot, exactly as before.
  const seen = new Set();
  const byId = new Map();
  for (const rec of records) {
    if (!rec || typeof rec.id !== "string") continue;
    if (rec.deleted === true) {
      byId.delete(rec.id);
      continue;
    }
    if (!seen.has(rec.id)) {
      seen.add(rec.id);
      order.push(rec.id);
    }
    byId.set(rec.id, rec);
  }
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

/** When a response was first sent (unix seconds); edits keep this. */
export function responseSentAt(rec) {
  const sent = Number(rec?.sent_at);
  return Number.isFinite(sent) && sent > 0 ? sent : Number(rec?.at) || 0;
}

/**
 * One CSV cell. Anyone with the answer link can type an answer, and a cell
 * starting with = + - @ (or a tab/CR) runs as a formula in Excel, Numbers,
 * and Sheets — prefix those with an apostrophe so they open as text.
 */
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Client-side CSV export of the responses file. Columns are every question
 * id seen in the data plus the form's current questions — a deleted question
 * keeps its column (keyed by id, so renames don't orphan data).
 *
 * @param {{ id: string, label: string }[]} columns
 * @param {FormResponse[]} responses latest-wins records
 * @param {(column: object, value: unknown) => string} formatValue
 * @returns {string}
 */
export function responsesToCsv(columns, responses, formatValue) {
  const header = ["Submitted", ...columns.map((c) => c.label)];
  const lines = [header.map(csvCell).join(",")];
  for (const rec of responses) {
    const sent = responseSentAt(rec);
    const at = sent ? new Date(sent * 1000).toISOString() : "";
    const answers = isObject(rec.answers) ? rec.answers : {};
    const cells = columns.map((col) => csvCell(formatValue(col, answers[col.id])));
    lines.push([csvCell(at), ...cells].join(","));
  }
  return `${lines.join("\n")}\n`;
}
