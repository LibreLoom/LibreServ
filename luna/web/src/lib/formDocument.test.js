import { describe, expect, it } from "vitest";
import {
  countResponses,
  latestResponses,
  newEditToken,
  newQuestionId,
  parseFormDocument,
  parseResponsesJsonl,
  responsesSiblingPath,
  responsesToCsv,
  serializeFormDocument,
} from "./formDocument.js";

describe("formDocument", () => {
  it("names the sibling responses file next to the form", () => {
    expect(responsesSiblingPath("forms/rsvp.lunaform")).toBe("forms/rsvp.responses.jsonl");
    expect(responsesSiblingPath("Party.LUNAFORM")).toBe("Party.responses.jsonl");
    expect(responsesSiblingPath("odd")).toBe("odd.responses.jsonl");
  });

  it("parses a real document and treats an empty file as a new form", () => {
    const doc = {
      version: 1,
      title: "RSVP",
      description: "Tell us",
      settings: { collecting: false },
      questions: [{ id: "q_1", type: "yes_no", label: "Coming?" }],
    };
    const parsed = parseFormDocument(JSON.stringify(doc));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc.title).toBe("RSVP");
    expect(parsed.doc.settings.collecting).toBe(false);
    // Defaults fill in missing settings keys.
    expect(parsed.doc.settings.allowEdits).toBe(true);

    const empty = parseFormDocument("   ");
    expect(empty.ok).toBe(true);
    expect(empty.doc.questions).toEqual([]);
  });

  it("round-trips unknown fields instead of stripping them", () => {
    const doc = {
      version: 1,
      title: "T",
      futureTopLevel: { keeps: "me" },
      settings: { collecting: true, futureFlag: 7 },
      questions: [
        { id: "q_1", type: "choice", label: "Pick", config: { options: ["a"], future: true } },
      ],
    };
    const { ok, doc: parsed } = parseFormDocument(JSON.stringify(doc));
    expect(ok).toBe(true);
    const out = JSON.parse(serializeFormDocument(parsed));
    expect(out.futureTopLevel).toEqual({ keeps: "me" });
    expect(out.settings.futureFlag).toBe(7);
    expect(out.questions[0].config.future).toBe(true);
  });

  it("refuses newer versions and non-form JSON", () => {
    const newer = parseFormDocument(JSON.stringify({ version: 99, questions: [] }));
    expect(newer.ok).toBe(false);
    expect(newer.error).toMatch(/newer version of Luna/i);
    expect(parseFormDocument("[1,2]").ok).toBe(false);
    expect(parseFormDocument("not json").ok).toBe(false);
  });

  it("makes distinct question ids and url-safe edit tokens", () => {
    expect(newQuestionId()).not.toBe(newQuestionId());
    expect(newQuestionId()).toMatch(/^q_[0-9a-f]+$/);
    const token = newEditToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newEditToken()).not.toBe(token);
  });

  it("parses JSONL responses, skipping torn lines", () => {
    const text = [
      JSON.stringify({ v: 1, id: "r_1", at: 1, answers: { q_1: "Yes" } }),
      "this is not json",
      JSON.stringify({ no_id: true }),
      "",
      JSON.stringify({ v: 1, id: "r_2", at: 2, answers: {} }),
    ].join("\n");
    const records = parseResponsesJsonl(text);
    expect(records.map((r) => r.id)).toEqual(["r_1", "r_2"]);
  });

  it("resolves edits latest-wins without inflating the count", () => {
    const text = [
      JSON.stringify({ v: 1, id: "r_1", edit: "h1", at: 1, answers: { q_1: "Yes" } }),
      JSON.stringify({ v: 1, id: "r_2", edit: "h2", at: 2, answers: { q_1: "No" } }),
      JSON.stringify({ v: 1, id: "r_1", edit: "h1", at: 3, answers: { q_1: "Maybe" } }),
    ].join("\n");
    const latest = latestResponses(parseResponsesJsonl(text));
    expect(latest).toHaveLength(2);
    // r_1 keeps its original slot but carries the edited answers.
    expect(latest[0].id).toBe("r_1");
    expect(latest[0].answers.q_1).toBe("Maybe");
    expect(countResponses(text)).toBe(2);
    expect(countResponses("")).toBe(0);
  });

  it("exports CSV with a column per question, escaping commas and quotes", () => {
    const responses = latestResponses(parseResponsesJsonl([
      JSON.stringify({ v: 1, id: "r_1", at: 1727000000, answers: { q_1: "Yes, chef", q_2: ["a", "b"] } }),
    ].join("\n")));
    const columns = [
      { id: "q_1", label: "Coming?" },
      { id: "q_2", label: "Sides" },
      { id: "q_gone", label: "q_gone" },
    ];
    const csv = responsesToCsv(columns, responses, (col, value) =>
      Array.isArray(value) ? value.join("; ") : String(value ?? ""),
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Submitted,Coming?,Sides,q_gone");
    expect(lines[1]).toContain('"Yes, chef"');
    expect(lines[1]).toContain("a; b");
    // Deleted question keeps its (empty) column.
    expect(lines[1].endsWith(",")).toBe(true);
  });
});
