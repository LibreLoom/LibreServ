/**
 * The shared form document inside a Yjs doc.
 *
 * Text files sync a Y.Text. A form syncs a Y.Map so two people can edit
 * different questions without clobbering each other's JSON. The file on
 * the drive is still the pretty JSON envelope — `readForm` / `writeForm`
 * are the only translation.
 *
 *   form (Y.Map)
 *     passthrough  JSON of unknown top-level keys
 *     version
 *     title, description   Y.Text
 *     settings     Y.Map of primitives + a passthrough string
 *     questions    Y.Array of Y.Map
 *       v, id, type, required, image, passthrough
 *       label, help   Y.Text
 *       config        Y.Map: allowOther, min, max, passthrough,
 *                     options → Y.Array of Y.Map { id, label: Y.Text }
 *       logic         Y.Map: questionId, equals
 *
 * Every piece of text people type is a Y.Text, so two people typing in the
 * same field merge instead of overwriting each other. Option ids only live
 * in the Y.Doc (the file stores plain strings); they keep React keys and
 * animations stable while people edit.
 *
 * Yjs types can't be read before they're in a document, and a type that
 * was deleted can't be inserted again. New questions are built with
 * `buildQuestion` (writes only), and a move inserts a fresh copy.
 */

import * as Y from "yjs";
import {
  canonicalSettings,
  parseFormDocument,
  serializeFormDocument,
} from "./formDocument.js";

const QUESTION_KEYS = ["v", "id", "type", "label", "help", "required", "image", "config", "logic"];
const CONFIG_KEYS = ["options", "allowOther", "min", "max"];
const SETTING_KEYS = ["responseLimit", "allowEdits", "collecting", "thankYou", "closeOn", "maxResponses"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function randomId() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {Y.Doc} ydoc */
export function formMap(ydoc) {
  return ydoc.getMap("form");
}

/** @param {unknown} value */
function textOf(value) {
  if (value instanceof Y.Text) return value.toString();
  return typeof value === "string" ? value : "";
}

/**
 * Change a Y.Text to `next` with the smallest edit: keep the shared prefix
 * and suffix, replace the middle. Concurrent typing elsewhere in the field
 * survives because only the changed span is touched.
 * @param {Y.Text} ytext
 * @param {string} next
 */
export function setYText(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev -= 1;
    endNext -= 1;
  }
  const apply = () => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  };
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();
}

/** Write `text` into `map[key]`, creating the Y.Text on first use. */
function setTextField(map, key, text) {
  const current = map.get(key);
  if (current instanceof Y.Text) {
    setYText(current, text);
  } else {
    map.set(key, new Y.Text(text));
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} known
 */
function extrasOf(obj, known) {
  const skip = new Set([...known, "passthrough"]);
  /** @type {Record<string, unknown>} */
  const extras = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!skip.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length ? JSON.stringify(extras) : "";
}

/** @param {Y.Map<unknown>} map */
function readPassthrough(map) {
  const raw = map.get("passthrough");
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {{ id?: string, label: string }} option */
function buildOption(option) {
  const map = new Y.Map();
  map.set("id", option.id || randomId());
  map.set("label", new Y.Text(option.label));
  return map;
}

/**
 * Options arrive as plain strings from the file, or as `{id, label}` when a
 * move copies a question and should keep its option ids.
 * @param {unknown} raw
 * @returns {{ id?: string, label: string }[]}
 */
function optionEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      if (typeof o === "string") return { label: o };
      if (isObject(o) && typeof o.label === "string") {
        return { id: typeof o.id === "string" ? o.id : undefined, label: o.label };
      }
      return null;
    })
    .filter(Boolean);
}

/** A fresh config map — writes only, safe before integration. */
function buildConfig(src) {
  const raw = isObject(src) ? src : {};
  const config = new Y.Map();
  const extras = extrasOf(raw, CONFIG_KEYS);
  if (extras) config.set("passthrough", extras);
  if (Array.isArray(raw.options)) {
    const list = new Y.Array();
    const entries = optionEntries(raw.options);
    if (entries.length) list.push(entries.map(buildOption));
    config.set("options", list);
  }
  if (raw.allowOther === true) config.set("allowOther", true);
  if (typeof raw.min === "number" && Number.isFinite(raw.min)) config.set("min", raw.min);
  if (typeof raw.max === "number" && Number.isFinite(raw.max)) config.set("max", raw.max);
  return config;
}

/**
 * A fresh question map — writes only, never reads, so it is safe before
 * the map is inserted into the document.
 * @param {object} question
 */
export function buildQuestion(question) {
  const src = isObject(question) ? question : {};
  const map = new Y.Map();
  const extras = extrasOf(src, QUESTION_KEYS);
  if (extras) map.set("passthrough", extras);
  map.set("v", typeof src.v === "number" ? src.v : 1);
  map.set("id", typeof src.id === "string" ? src.id : "");
  map.set("type", typeof src.type === "string" ? src.type : "short_text");
  map.set("label", new Y.Text(typeof src.label === "string" ? src.label : ""));
  map.set("help", new Y.Text(typeof src.help === "string" ? src.help : ""));
  if (src.required === true) map.set("required", true);
  if (typeof src.image === "string" && src.image) map.set("image", src.image);
  map.set("config", buildConfig(src.config));
  if (isObject(src.logic) && typeof src.logic.questionId === "string" && src.logic.questionId) {
    const logic = new Y.Map();
    logic.set("questionId", src.logic.questionId);
    logic.set("equals", src.logic.equals == null ? "" : String(src.logic.equals));
    map.set("logic", logic);
  }
  return map;
}

/**
 * @param {Y.Map<unknown>} config
 * @param {boolean} withIds
 */
function readConfig(config, withIds) {
  /** @type {Record<string, unknown>} */
  const out = { ...readPassthrough(config) };
  const options = config.get("options");
  if (options instanceof Y.Array) {
    const list = options.toArray().filter((o) => o instanceof Y.Map);
    out.options = list.map((o) => textOf(o.get("label")));
    if (withIds) out.optionIds = list.map((o) => String(o.get("id") || ""));
  }
  if (config.get("allowOther") === true) out.allowOther = true;
  const min = config.get("min");
  const max = config.get("max");
  if (typeof min === "number") out.min = min;
  if (typeof max === "number") out.max = max;
  return out;
}

/**
 * @param {Y.Map<unknown>} map
 * @param {boolean} withIds
 */
function readQuestion(map, withIds) {
  /** @type {Record<string, unknown>} */
  const out = {
    ...readPassthrough(map),
    v: typeof map.get("v") === "number" ? map.get("v") : 1,
    id: typeof map.get("id") === "string" ? map.get("id") : "",
    type: typeof map.get("type") === "string" ? map.get("type") : "short_text",
    label: textOf(map.get("label")),
  };
  if (map.get("required") === true) out.required = true;
  const help = textOf(map.get("help"));
  if (help) out.help = help;
  const image = map.get("image");
  if (typeof image === "string" && image) out.image = image;
  const config = map.get("config");
  out.config = config instanceof Y.Map ? readConfig(config, withIds) : {};
  const logic = map.get("logic");
  if (logic instanceof Y.Map && typeof logic.get("questionId") === "string") {
    out.logic = {
      questionId: logic.get("questionId"),
      equals: logic.get("equals") == null ? "" : String(logic.get("equals")),
    };
  }
  return out;
}

/** A fresh settings map from any settings object. */
function buildSettings(src) {
  const canon = canonicalSettings(src);
  const settings = new Y.Map();
  const extras = extrasOf(canon, SETTING_KEYS);
  if (extras) settings.set("passthrough", extras);
  for (const key of SETTING_KEYS) {
    // Empty string and null are real defaults — keep them so a re-read
    // canonicalizes the same way parseFormDocument does. maxResponses
    // stores 0 for "no limit" because Y.Map values can't be null.
    const value = canon[key];
    settings.set(key, key === "maxResponses" ? (value ?? 0) : value);
  }
  return settings;
}

/** @param {Y.Map<unknown>} settings */
function readSettings(settings) {
  /** @type {Record<string, unknown>} */
  const raw = { ...readPassthrough(settings) };
  settings.forEach((value, key) => {
    if (key !== "passthrough") raw[key] = value;
  });
  if (raw.maxResponses === 0) raw.maxResponses = null;
  return canonicalSettings(raw);
}

/**
 * Replace the shared map with `doc`.
 * @param {Y.Doc} ydoc
 * @param {object} doc
 */
export function writeForm(ydoc, doc) {
  const map = formMap(ydoc);
  const src = isObject(doc) ? doc : {};
  ydoc.transact(() => {
    const extras = extrasOf(src, ["version", "title", "description", "settings", "questions"]);
    if (extras) map.set("passthrough", extras);
    else map.delete("passthrough");
    map.set("version", typeof src.version === "number" ? src.version : 1);
    map.set("title", new Y.Text(typeof src.title === "string" ? src.title : ""));
    map.set("description", new Y.Text(typeof src.description === "string" ? src.description : ""));
    map.set("settings", buildSettings(src.settings));
    const questions = new Y.Array();
    const list = Array.isArray(src.questions) ? src.questions.filter(isObject) : [];
    if (list.length) questions.push(list.map(buildQuestion));
    map.set("questions", questions);
  });
}

/**
 * Plain document, or null when the map has never been seeded.
 * `withIds` adds `config.optionIds` for the builder; never serialize that.
 * @param {Y.Doc} ydoc
 * @param {{ withIds?: boolean }} [opts]
 */
export function readForm(ydoc, { withIds = false } = {}) {
  const map = formMap(ydoc);
  if (map.size === 0) return null;
  const settings = map.get("settings");
  const questions = map.get("questions");
  return {
    ...readPassthrough(map),
    version: typeof map.get("version") === "number" ? map.get("version") : 1,
    title: textOf(map.get("title")),
    description: textOf(map.get("description")),
    settings: settings instanceof Y.Map ? readSettings(settings) : canonicalSettings(null),
    questions: questions instanceof Y.Array
      ? questions
        .toArray()
        .filter((q) => q instanceof Y.Map)
        .map((q) => readQuestion(/** @type {Y.Map<unknown>} */ (q), withIds))
      : [],
  };
}

/** Pretty JSON for the file on the drive. Empty until seeded. */
export function serializeForm(ydoc) {
  const doc = readForm(ydoc);
  return doc ? serializeFormDocument(doc) : "";
}

/**
 * Seed from file bytes. Returns the canonical JSON that serialize will
 * produce, so the editor's dirty baseline can match without a second parse.
 * @param {Y.Doc} ydoc
 * @param {string} content
 */
export function seedForm(ydoc, content) {
  const parsed = parseFormDocument(content);
  const doc = parsed.ok ? parsed.doc : { version: 1, title: "", description: "", settings: {}, questions: [] };
  writeForm(ydoc, doc);
  return serializeForm(ydoc);
}

/** @param {Y.Doc} ydoc */
export function formIsEmpty(ydoc) {
  return formMap(ydoc).size === 0;
}

/**
 * CollabDocSync adapter. The default text adapter is untouched; forms opt in.
 * @returns {import("../components/files/collabDocSync.js").DocAdapter}
 */
export function formCollabAdapter() {
  return {
    isEmpty: (ydoc) => formIsEmpty(ydoc),
    seed: (ydoc, content) => { seedForm(ydoc, content); },
    serialize: (ydoc) => serializeForm(ydoc),
    // Forms are keyed by question ID in a Y.Map; concurrent seeds merge
    // cleanly without duplicating. Never wipe the form on join/reconnect.
    matchesSeed: () => false,
    clear: () => {},
  };
}

/** Canonical JSON for file bytes, without touching a Y.Doc. */
export function seedFormSnapshot(content) {
  const parsed = parseFormDocument(content);
  if (!parsed.ok || !parsed.doc) return "";
  const probe = new Y.Doc();
  try {
    return seedForm(probe, content);
  } finally {
    probe.destroy();
  }
}

/** @param {Y.Doc} ydoc */
function questionsArray(ydoc) {
  let questions = formMap(ydoc).get("questions");
  if (!(questions instanceof Y.Array)) {
    questions = new Y.Array();
    formMap(ydoc).set("questions", questions);
  }
  return /** @type {Y.Array<Y.Map<unknown>>} */ (questions);
}

/** @param {Y.Doc} ydoc @param {string} id */
function questionIndex(ydoc, id) {
  return questionsArray(ydoc)
    .toArray()
    .findIndex((item) => item instanceof Y.Map && item.get("id") === id);
}

/** @param {Y.Doc} ydoc @param {string} id */
function questionMap(ydoc, id) {
  const idx = questionIndex(ydoc, id);
  return idx >= 0 ? questionsArray(ydoc).get(idx) : null;
}

/**
 * Drop skip rules that can no longer fire: the question they depend on is
 * gone or no longer comes before them.
 * @param {Y.Doc} ydoc
 */
function pruneLogic(ydoc) {
  const list = questionsArray(ydoc).toArray();
  const position = new Map(list.map((item, i) => [item.get("id"), i]));
  list.forEach((item, i) => {
    const logic = item.get("logic");
    if (!(logic instanceof Y.Map)) return;
    const trigger = position.get(logic.get("questionId"));
    if (trigger == null || trigger >= i) item.delete("logic");
  });
}

/** @param {Y.Doc} ydoc @param {string} title */
export function setFormTitle(ydoc, title) {
  setTextField(formMap(ydoc), "title", title);
}

/** @param {Y.Doc} ydoc @param {string} description */
export function setFormDescription(ydoc, description) {
  setTextField(formMap(ydoc), "description", description);
}

/** @param {Y.Doc} ydoc @param {string} key @param {unknown} value */
export function setFormSetting(ydoc, key, value) {
  let settings = formMap(ydoc).get("settings");
  if (!(settings instanceof Y.Map)) {
    settings = new Y.Map();
    formMap(ydoc).set("settings", settings);
  }
  const map = /** @type {Y.Map<unknown>} */ (settings);
  if (key === "maxResponses") {
    const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    map.set("maxResponses", n);
    return;
  }
  if (value == null) map.delete(key);
  else map.set(key, value);
}

/**
 * Insert a plain question at `index` (end when omitted).
 * @param {Y.Doc} ydoc
 * @param {object} question plain question (id required)
 * @param {number} [index]
 */
export function addFormQuestion(ydoc, question, index) {
  const questions = questionsArray(ydoc);
  const at = typeof index === "number" ? Math.max(0, Math.min(index, questions.length)) : questions.length;
  questions.insert(at, [buildQuestion(question)]);
}

/**
 * Remove a question, and any skip rule that pointed at it. Returns what
 * was removed so the caller can offer Undo.
 * @param {Y.Doc} ydoc
 * @param {string} id
 * @returns {{ question: object, index: number } | null}
 */
export function removeFormQuestion(ydoc, id) {
  const idx = questionIndex(ydoc, id);
  if (idx < 0) return null;
  const questions = questionsArray(ydoc);
  const removed = readQuestion(questions.get(idx), true);
  ydoc.transact(() => {
    questions.delete(idx, 1);
    pruneLogic(ydoc);
  });
  return { question: withOptionEntries(removed), index: idx };
}

/**
 * Turn `config.options` + `config.optionIds` back into `{id, label}`
 * entries so a copy keeps its option ids.
 * @param {Record<string, any>} question
 */
function withOptionEntries(question) {
  const config = { ...(question.config || {}) };
  if (Array.isArray(config.options)) {
    const ids = Array.isArray(config.optionIds) ? config.optionIds : [];
    config.options = config.options.map((label, i) => ({ id: ids[i], label }));
  }
  delete config.optionIds;
  return { ...question, config };
}

/**
 * Move a question. A Yjs type can't be re-inserted once deleted, so the
 * move inserts a copy (same id, same option ids) and removes the original.
 * Skip rules that would now point forward are dropped.
 * @param {Y.Doc} ydoc
 * @param {number} from
 * @param {number} to
 */
export function moveFormQuestion(ydoc, from, to) {
  const questions = questionsArray(ydoc);
  if (from === to || from < 0 || to < 0 || from >= questions.length || to >= questions.length) return;
  const copy = withOptionEntries(readQuestion(questions.get(from), true));
  ydoc.transact(() => {
    questions.delete(from, 1);
    questions.insert(to, [buildQuestion(copy)]);
    pruneLogic(ydoc);
  });
}

/**
 * Merge a plain patch onto one question. `logic: null` clears skip logic.
 * `config` sets allowOther/min/max; options have their own functions.
 * @param {Y.Doc} ydoc
 * @param {string} id
 * @param {object} patch
 */
export function patchFormQuestion(ydoc, id, patch) {
  const map = questionMap(ydoc, id);
  if (!map) return;
  ydoc.transact(() => {
    if ("label" in patch) setTextField(map, "label", String(patch.label ?? ""));
    if ("help" in patch) setTextField(map, "help", String(patch.help ?? ""));
    if ("type" in patch) map.set("type", String(patch.type ?? "short_text"));
    if ("required" in patch) {
      if (patch.required) map.set("required", true);
      else map.delete("required");
    }
    if ("image" in patch) {
      const image = String(patch.image ?? "");
      if (image) map.set("image", image);
      else map.delete("image");
    }
    if ("config" in patch && isObject(patch.config)) {
      const config = configMap(map);
      // `options: null` drops the list (a type change away from choices).
      if (patch.config.options === null) config.delete("options");
      for (const key of ["allowOther", "min", "max"]) {
        if (!(key in patch.config)) continue;
        const value = patch.config[key];
        if (key === "allowOther" ? value === true : typeof value === "number" && Number.isFinite(value)) {
          config.set(key, value);
        } else {
          config.delete(key);
        }
      }
    }
    if ("logic" in patch) {
      if (isObject(patch.logic) && patch.logic.questionId) {
        const logic = new Y.Map();
        logic.set("questionId", String(patch.logic.questionId));
        logic.set("equals", patch.logic.equals == null ? "" : String(patch.logic.equals));
        map.set("logic", logic);
      } else {
        map.delete("logic");
      }
    }
  });
}

/** @param {Y.Map<unknown>} question */
function configMap(question) {
  let config = question.get("config");
  if (!(config instanceof Y.Map)) {
    config = new Y.Map();
    question.set("config", config);
  }
  return /** @type {Y.Map<unknown>} */ (config);
}

/** @param {Y.Map<unknown>} question */
function optionsArray(question) {
  const config = configMap(question);
  let list = config.get("options");
  if (!(list instanceof Y.Array)) {
    list = new Y.Array();
    config.set("options", list);
  }
  return /** @type {Y.Array<Y.Map<unknown>>} */ (list);
}

/** @param {Y.Array<Y.Map<unknown>>} list @param {string} optionId */
function optionIndex(list, optionId) {
  return list.toArray().findIndex((o) => o instanceof Y.Map && o.get("id") === optionId);
}

/**
 * Add one option to a question; returns its id.
 * @param {Y.Doc} ydoc @param {string} questionId @param {string} label
 */
export function addFormOption(ydoc, questionId, label) {
  const map = questionMap(ydoc, questionId);
  if (!map) return "";
  const id = randomId();
  ydoc.transact(() => optionsArray(map).push([buildOption({ id, label })]));
  return id;
}

/** @param {Y.Doc} ydoc @param {string} questionId @param {string} optionId @param {string} label */
export function setFormOptionLabel(ydoc, questionId, optionId, label) {
  const map = questionMap(ydoc, questionId);
  if (!map) return;
  const list = optionsArray(map);
  const idx = optionIndex(list, optionId);
  if (idx < 0) return;
  const option = list.get(idx);
  ydoc.transact(() => setTextField(option, "label", label));
}

/** @param {Y.Doc} ydoc @param {string} questionId @param {string} optionId */
export function removeFormOption(ydoc, questionId, optionId) {
  const map = questionMap(ydoc, questionId);
  if (!map) return;
  const list = optionsArray(map);
  const idx = optionIndex(list, optionId);
  if (idx >= 0) list.delete(idx, 1);
}

/**
 * Replace a question's options wholesale (a type change to a choice type
 * that had none yet).
 * @param {Y.Doc} ydoc @param {string} questionId @param {string[]} labels
 */
export function setFormOptions(ydoc, questionId, labels) {
  const map = questionMap(ydoc, questionId);
  if (!map) return;
  ydoc.transact(() => {
    const list = optionsArray(map);
    if (list.length) list.delete(0, list.length);
    if (labels.length) list.push(labels.map((label) => buildOption({ label })));
  });
}

/**
 * Give every question a unique, non-empty id. Answers key on the id, so two
 * questions sharing one would share every answer typed into them. Returns
 * true when anything changed.
 * @param {Y.Doc} ydoc
 * @param {() => string} newId
 */
export function repairQuestionIds(ydoc, newId) {
  const list = questionsArray(ydoc).toArray();
  const seen = new Set();
  const broken = [];
  for (const item of list) {
    const id = item.get("id");
    if (typeof id !== "string" || !id || seen.has(id)) broken.push(item);
    else seen.add(id);
  }
  if (!broken.length) return false;
  ydoc.transact(() => {
    for (const item of broken) {
      let id = newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
      item.set("id", id);
    }
  });
  return true;
}
