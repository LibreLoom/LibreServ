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
 *     version, title, description
 *     settings     Y.Map of primitives + a passthrough string
 *     questions    Y.Array of Y.Map
 */

import * as Y from "yjs";
import {
  canonicalSettings,
  parseFormDocument,
  serializeFormDocument,
} from "./formDocument.js";

const QUESTION_KEYS = ["v", "id", "type", "label", "help", "required", "image", "config", "logic"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {Y.Doc} ydoc */
export function formMap(ydoc) {
  return ydoc.getMap("form");
}

/**
 * @param {Y.Map<unknown>} map
 * @param {Record<string, unknown>} obj
 * @param {string[]} known
 */
function writePassthrough(map, obj, known) {
  const skip = new Set(known);
  /** @type {Record<string, unknown>} */
  const extras = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!skip.has(key)) extras[key] = value;
  }
  if (Object.keys(extras).length) map.set("passthrough", JSON.stringify(extras));
  else map.delete("passthrough");
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

/**
 * @param {Y.Map<unknown>} config
 * @param {object} src
 */
function writeConfig(config, src) {
  const raw = isObject(src) ? src : {};
  writePassthrough(config, raw, ["options", "allowOther", "min", "max", "passthrough"]);
  if (Array.isArray(raw.options)) {
    let list = config.get("options");
    if (!(list instanceof Y.Array)) {
      list = new Y.Array();
      config.set("options", list);
    }
    const arr = /** @type {Y.Array<string>} */ (list);
    if (arr.length) arr.delete(0, arr.length);
    const options = raw.options.filter((o) => typeof o === "string");
    if (options.length) arr.push(options);
  } else {
    config.delete("options");
  }
  if (raw.allowOther === true) config.set("allowOther", true);
  else config.delete("allowOther");
  if (typeof raw.min === "number" && Number.isFinite(raw.min)) config.set("min", raw.min);
  else config.delete("min");
  if (typeof raw.max === "number" && Number.isFinite(raw.max)) config.set("max", raw.max);
  else config.delete("max");
}

/** @param {Y.Map<unknown>} config */
function readConfig(config) {
  /** @type {Record<string, unknown>} */
  const out = { ...readPassthrough(config) };
  const options = config.get("options");
  if (options instanceof Y.Array) {
    out.options = options.toArray().filter((o) => typeof o === "string");
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
 * @param {object} question
 */
function writeQuestion(map, question) {
  const src = isObject(question) ? question : {};
  writePassthrough(map, src, [...QUESTION_KEYS, "passthrough"]);
  map.set("v", typeof src.v === "number" ? src.v : 1);
  map.set("id", typeof src.id === "string" ? src.id : "");
  map.set("type", typeof src.type === "string" ? src.type : "short_text");
  map.set("label", typeof src.label === "string" ? src.label : "");
  if (typeof src.help === "string" && src.help) map.set("help", src.help);
  else map.delete("help");
  if (src.required === true) map.set("required", true);
  else map.delete("required");
  if (typeof src.image === "string" && src.image) map.set("image", src.image);
  else map.delete("image");
  let config = map.get("config");
  if (!(config instanceof Y.Map)) {
    config = new Y.Map();
    map.set("config", config);
  }
  writeConfig(/** @type {Y.Map<unknown>} */ (config), src.config);
  if (isObject(src.logic) && typeof src.logic.questionId === "string" && src.logic.questionId) {
    let logic = map.get("logic");
    if (!(logic instanceof Y.Map)) {
      logic = new Y.Map();
      map.set("logic", logic);
    }
    const logicMap = /** @type {Y.Map<unknown>} */ (logic);
    logicMap.set("questionId", src.logic.questionId);
    logicMap.set("equals", src.logic.equals == null ? "" : String(src.logic.equals));
  } else {
    map.delete("logic");
  }
}

/** @param {Y.Map<unknown>} map */
function readQuestion(map) {
  /** @type {Record<string, unknown>} */
  const out = {
    ...readPassthrough(map),
    v: typeof map.get("v") === "number" ? map.get("v") : 1,
    id: typeof map.get("id") === "string" ? map.get("id") : "",
    type: typeof map.get("type") === "string" ? map.get("type") : "short_text",
    label: typeof map.get("label") === "string" ? map.get("label") : "",
  };
  if (map.get("required") === true) out.required = true;
  const help = map.get("help");
  if (typeof help === "string" && help) out.help = help;
  const image = map.get("image");
  if (typeof image === "string" && image) out.image = image;
  const config = map.get("config");
  out.config = config instanceof Y.Map ? readConfig(config) : {};
  const logic = map.get("logic");
  if (logic instanceof Y.Map && typeof logic.get("questionId") === "string") {
    out.logic = {
      questionId: logic.get("questionId"),
      equals: logic.get("equals") == null ? "" : String(logic.get("equals")),
    };
  }
  return out;
}

/**
 * @param {Y.Map<unknown>} settings
 * @param {object} src
 */
function writeSettings(settings, src) {
  const canon = canonicalSettings(src);
  const known = [
    "responseLimit", "allowEdits", "collecting", "thankYou", "closeOn", "maxResponses", "notify",
  ];
  writePassthrough(settings, canon, [...known, "passthrough"]);
  for (const key of known) {
    const value = canon[key];
    if (value == null || value === "") settings.delete(key);
    else settings.set(key, value);
  }
  // Empty string and null are real defaults — keep them so a re-read
  // canonicalizes the same way parseFormDocument does.
  settings.set("thankYou", canon.thankYou);
  settings.set("closeOn", canon.closeOn);
  if (canon.maxResponses == null) settings.set("maxResponses", 0);
  else settings.set("maxResponses", canon.maxResponses);
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
 * Replace the shared map with `doc`. Call inside a transaction when mixing
 * with other edits; seed calls it on its own.
 * @param {Y.Doc} ydoc
 * @param {object} doc
 */
export function writeForm(ydoc, doc) {
  const map = formMap(ydoc);
  const src = isObject(doc) ? doc : {};
  ydoc.transact(() => {
    writePassthrough(map, src, ["version", "title", "description", "settings", "questions", "passthrough"]);
    map.set("version", typeof src.version === "number" ? src.version : 1);
    map.set("title", typeof src.title === "string" ? src.title : "");
    map.set("description", typeof src.description === "string" ? src.description : "");
    let settings = map.get("settings");
    if (!(settings instanceof Y.Map)) {
      settings = new Y.Map();
      map.set("settings", settings);
    }
    writeSettings(/** @type {Y.Map<unknown>} */ (settings), src.settings);
    let questions = map.get("questions");
    if (!(questions instanceof Y.Array)) {
      questions = new Y.Array();
      map.set("questions", questions);
    }
    const arr = /** @type {Y.Array<Y.Map<unknown>>} */ (questions);
    if (arr.length) arr.delete(0, arr.length);
    const list = Array.isArray(src.questions) ? src.questions.filter(isObject) : [];
    if (list.length) {
      arr.push(list.map((q) => {
        const item = new Y.Map();
        writeQuestion(item, q);
        return item;
      }));
    }
  });
}

/**
 * Plain document, or null when the map has never been seeded.
 * @param {Y.Doc} ydoc
 */
export function readForm(ydoc) {
  const map = formMap(ydoc);
  if (map.size === 0) return null;
  const settings = map.get("settings");
  const questions = map.get("questions");
  return {
    ...readPassthrough(map),
    version: typeof map.get("version") === "number" ? map.get("version") : 1,
    title: typeof map.get("title") === "string" ? map.get("title") : "",
    description: typeof map.get("description") === "string" ? map.get("description") : "",
    settings: settings instanceof Y.Map ? readSettings(settings) : canonicalSettings(null),
    questions: questions instanceof Y.Array
      ? questions.toArray().filter((q) => q instanceof Y.Map).map((q) => readQuestion(/** @type {Y.Map<unknown>} */ (q)))
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

/** @param {Y.Doc} ydoc */
export function clearForm(ydoc) {
  const map = formMap(ydoc);
  const keys = [];
  map.forEach((_value, key) => keys.push(key));
  for (const key of keys) map.delete(key);
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
    matchesSeed: (ydoc, seed) => serializeForm(ydoc) === seedFormSnapshot(seed),
    clear: (ydoc) => clearForm(ydoc),
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

/** @param {Y.Doc} ydoc @param {string} id */
function questionMap(ydoc, id) {
  const questions = formMap(ydoc).get("questions");
  if (!(questions instanceof Y.Array)) return null;
  for (const item of questions.toArray()) {
    if (item instanceof Y.Map && item.get("id") === id) return item;
  }
  return null;
}

/** @param {Y.Doc} ydoc @param {string} title */
export function setFormTitle(ydoc, title) {
  formMap(ydoc).set("title", title);
}

/** @param {Y.Doc} ydoc @param {string} description */
export function setFormDescription(ydoc, description) {
  formMap(ydoc).set("description", description);
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
 * @param {Y.Doc} ydoc
 * @param {object} question plain question (id required)
 */
export function addFormQuestion(ydoc, question) {
  let questions = formMap(ydoc).get("questions");
  if (!(questions instanceof Y.Array)) {
    questions = new Y.Array();
    formMap(ydoc).set("questions", questions);
  }
  const item = new Y.Map();
  writeQuestion(item, question);
  /** @type {Y.Array<Y.Map<unknown>>} */ (questions).push([item]);
}

/** @param {Y.Doc} ydoc @param {string} id */
export function removeFormQuestion(ydoc, id) {
  const questions = formMap(ydoc).get("questions");
  if (!(questions instanceof Y.Array)) return;
  const idx = questions.toArray().findIndex((item) => item instanceof Y.Map && item.get("id") === id);
  if (idx >= 0) questions.delete(idx, 1);
}

/** @param {Y.Doc} ydoc @param {number} from @param {number} to */
export function moveFormQuestion(ydoc, from, to) {
  const questions = formMap(ydoc).get("questions");
  if (!(questions instanceof Y.Array)) return;
  if (from === to || from < 0 || to < 0 || from >= questions.length || to >= questions.length) return;
  ydoc.transact(() => {
    const item = questions.get(from);
    questions.delete(from, 1);
    questions.insert(to, [item]);
  });
}

/**
 * Merge a plain patch onto one question. `config` replaces the config bag
 * (the card always sends the whole bag). `logic: null` clears skip logic.
 * @param {Y.Doc} ydoc
 * @param {string} id
 * @param {object} patch
 */
export function patchFormQuestion(ydoc, id, patch) {
  const map = questionMap(ydoc, id);
  if (!map) return;
  ydoc.transact(() => {
    if ("label" in patch) map.set("label", String(patch.label ?? ""));
    if ("type" in patch) map.set("type", String(patch.type ?? "short_text"));
    if ("help" in patch) {
      const help = String(patch.help ?? "");
      if (help) map.set("help", help);
      else map.delete("help");
    }
    if ("required" in patch) {
      if (patch.required) map.set("required", true);
      else map.delete("required");
    }
    if ("image" in patch) {
      const image = String(patch.image ?? "");
      if (image) map.set("image", image);
      else map.delete("image");
    }
    if ("config" in patch) {
      let config = map.get("config");
      if (!(config instanceof Y.Map)) {
        config = new Y.Map();
        map.set("config", config);
      }
      writeConfig(/** @type {Y.Map<unknown>} */ (config), patch.config);
    }
    if ("logic" in patch) {
      if (isObject(patch.logic) && patch.logic.questionId) {
        let logic = map.get("logic");
        if (!(logic instanceof Y.Map)) {
          logic = new Y.Map();
          map.set("logic", logic);
        }
        const logicMap = /** @type {Y.Map<unknown>} */ (logic);
        logicMap.set("questionId", String(patch.logic.questionId));
        logicMap.set("equals", patch.logic.equals == null ? "" : String(patch.logic.equals));
      } else {
        map.delete("logic");
      }
    }
  });
}
