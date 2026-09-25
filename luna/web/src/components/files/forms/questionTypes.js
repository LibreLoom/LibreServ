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
  HelpCircle,
  ListOrdered,
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
 *   summary: "bars" | "list",
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
};

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
