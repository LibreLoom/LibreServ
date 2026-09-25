/**
 * Luna Forms question type registry. Each type maps to a builder editor
 * (FormBuilder's question card), a responder screen (FormResponder), and a
 * summary renderer (FormResponses). Adding a type is additive: a new entry
 * here plus an input branch in the responder — the `.lunaform` envelope
 * doesn't change.
 */
import {
  AlignLeft,
  CalendarDays,
  CheckSquare,
  CircleDot,
  Hash,
  HelpCircle,
  ListOrdered,
  Mail,
  Paperclip,
  Type,
  ToggleLeft,
} from "lucide-react";

/**
 * @typedef {{
 *   label: string,
 *   icon: import("react").ElementType,
 *   hint: string,
 *   options?: boolean,
 *   multi?: boolean,
 *   fixedOptions?: string[],
 *   summary: "bars" | "list" | "number",
 * }} QuestionType
 */

/** @type {Record<string, QuestionType>} */
export const QUESTION_TYPES = {
  short_text: {
    label: "Short answer",
    icon: Type,
    hint: "A single line of text — a name, an email, a place.",
    summary: "list",
  },
  long_text: {
    label: "Long answer",
    icon: AlignLeft,
    hint: "A few sentences or paragraphs.",
    summary: "list",
  },
  choice: {
    label: "Multiple choice",
    icon: CircleDot,
    hint: "Pick exactly one option.",
    options: true,
    summary: "bars",
  },
  multi_choice: {
    label: "Checkboxes",
    icon: CheckSquare,
    hint: "Pick as many options as apply.",
    options: true,
    multi: true,
    summary: "bars",
  },
  dropdown: {
    label: "Dropdown",
    icon: ListOrdered,
    hint: "Pick one option from a compact list.",
    options: true,
    summary: "bars",
  },
  date: {
    label: "Date",
    icon: CalendarDays,
    hint: "A day on the calendar.",
    summary: "list",
  },
  yes_no: {
    label: "Yes or no",
    icon: ToggleLeft,
    hint: "A quick yes/no pick.",
    fixedOptions: ["Yes", "No"],
    summary: "bars",
  },
  number: {
    label: "Number",
    icon: Hash,
    hint: "A number — how many people, a price, an age. Results show the total.",
    summary: "number",
  },
  email: {
    label: "Email",
    icon: Mail,
    hint: "An email address. Luna checks that it looks like one.",
    summary: "list",
  },
  file: {
    label: "File",
    icon: Paperclip,
    hint: "A photo or PDF, kept on this Luna next to the form.",
    summary: "list",
  },
};

/** Photos and PDFs a respondent may attach. */
export const FILE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,.jpg,.jpeg,.png,.gif,.webp,.pdf";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const FILE_EXT = new Set([...IMAGE_EXT, "pdf"]);

/** @param {string} name */
export function fileExt(name) {
  const base = String(name || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** A picture already on the drive can sit on a question. */
export function isImageFileName(name) {
  return IMAGE_EXT.has(fileExt(name));
}

/** Respondent attachments: photos and PDFs only. */
export function isAllowedUploadName(name) {
  return FILE_EXT.has(fileExt(name));
}

/** Loose shape check — enough to catch a missing @ or a space. */
export function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());
}

export const QUESTION_TYPE_IDS = Object.keys(QUESTION_TYPES);

/** @type {QuestionType} */
const FALLBACK_TYPE = {
  label: "Question",
  icon: HelpCircle,
  hint: "",
  summary: "list",
};

/** Type info for `type`; unknown future types degrade to a text-ish card. */
export function typeInfo(type) {
  return QUESTION_TYPES[type] || { ...FALLBACK_TYPE, label: type || "Question" };
}

/** Fresh per-type config bag for a new question. */
export function defaultConfig(type) {
  return typeInfo(type).options ? { options: ["Option 1"] } : {};
}

/** Options a question offers, in display order. */
export function answerOptions(question) {
  const info = typeInfo(question?.type);
  if (info.fixedOptions) return info.fixedOptions;
  const options = question?.config?.options;
  return Array.isArray(options) ? options.filter((o) => typeof o === "string") : [];
}

/**
 * Skip this question when an earlier answer matches `logic`. A trigger that
 * is itself skipped never fires — the condition can't be met.
 *
 * @param {object} question
 * @param {object[]} questions in display order
 * @param {Record<string, unknown>} answers
 */
export function isQuestionSkipped(question, questions, answers) {
  const logic = question?.logic;
  if (!logic || typeof logic.questionId !== "string" || !logic.questionId) return false;
  const list = Array.isArray(questions) ? questions : [];
  const idx = list.findIndex((q) => q && q.id === question.id);
  const triggerIdx = list.findIndex((q) => q && q.id === logic.questionId);
  if (triggerIdx < 0 || idx < 0 || triggerIdx >= idx) return false;
  const trigger = list[triggerIdx];
  if (isQuestionSkipped(trigger, list, answers)) return false;
  const value = answers ? answers[logic.questionId] : undefined;
  const expect = logic.equals == null ? "" : String(logic.equals);
  if (Array.isArray(value)) return value.map(String).includes(expect);
  if (value == null) return expect === "";
  return String(value) === expect;
}

/** Questions the respondent should see, given the answers so far. */
export function visibleQuestions(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  return list.filter((q) => q && !isQuestionSkipped(q, list, answers));
}

/** Does an answer value count as filled in? Used for required gating. */
export function isAnswered(_question, value) {
  if (Array.isArray(value)) return value.length > 0;
  return value != null && String(value).trim() !== "";
}

/** One-line display string for an answer (tables, review screen, CSV). */
export function formatAnswer(question, value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (question?.type === "yes_no") {
    if (value === "yes") return "Yes";
    if (value === "no") return "No";
  }
  return String(value);
}

/**
 * Fold responses into a per-question summary. Choice-ish types get counts
 * per option (options with zero answers still show); text-ish types get the
 * list of answers.
 *
 * @param {object} question
 * @param {object[]} responses latest-wins records
 */
export function summarizeAnswers(question, responses) {
  const info = typeInfo(question?.type);
  const answered = responses
    .map((r) => (r && typeof r === "object" ? r.answers : null))
    .map((a) => (a && typeof a === "object" ? a[question.id] : undefined))
    .filter((v) => v != null && !(typeof v === "string" && v.trim() === "")
      && !(Array.isArray(v) && v.length === 0));

  if (info.summary === "number") {
    let total = 0;
    let numeric = 0;
    for (const value of answered) {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n)) {
        total += n;
        numeric += 1;
      }
    }
    return { kind: "number", total, count: numeric, answered: answered.length };
  }

  if (info.summary === "bars") {
    const counts = new Map();
    for (const option of answerOptions(question)) counts.set(option, 0);
    for (const value of answered) {
      const picks = Array.isArray(value) ? value : [value];
      for (const pick of picks) {
        const key = String(pick);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const rows = [...counts.entries()].map(([label, count]) => ({ label, count }));
    return { kind: "bars", rows, answered: answered.length };
  }
  return {
    kind: "list",
    items: answered.map((v) => formatAnswer(question, v)),
    answered: answered.length,
  };
}
