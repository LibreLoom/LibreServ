import { describe, expect, it } from "vitest";
import {
  isEmailAddress,
  isQuestionSkipped,
  summarizeAnswers,
  visibleQuestions,
} from "./questionTypes.js";

const questions = [
  { id: "q1", type: "yes_no", label: "Coming?" },
  { id: "q2", type: "short_text", label: "Name", logic: { questionId: "q1", equals: "no" } },
  { id: "q3", type: "email", label: "Email", logic: { questionId: "q2", equals: "skip-me" } },
];

describe("question skip and summaries", () => {
  it("hides a question when an earlier answer matches, and a skipped trigger does not fire", () => {
    expect(isQuestionSkipped(questions[1], questions, { q1: "no" })).toBe(true);
    expect(isQuestionSkipped(questions[1], questions, { q1: "yes" })).toBe(false);
    expect(visibleQuestions(questions, { q1: "yes" }).map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    // q2 is skipped, so q3's condition on q2 never fires.
    expect(isQuestionSkipped(questions[2], questions, { q1: "no", q2: "skip-me" })).toBe(false);
    expect(isEmailAddress("ada@example.com")).toBe(true);
    expect(isEmailAddress("not an email")).toBe(false);
  });

  it("totals number answers", () => {
    const summary = summarizeAnswers(
      { id: "n", type: "number" },
      [
        { answers: { n: 2 } },
        { answers: { n: "3" } },
        { answers: { n: "" } },
      ],
    );
    expect(summary).toEqual({ kind: "number", total: 5, count: 2, answered: 2 });
  });
});
