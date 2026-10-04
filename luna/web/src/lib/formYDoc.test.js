import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollabDocSync } from "../components/files/collabDocSync.js";
import {
  blankFormDocument,
  serializeFormDocument,
} from "./formDocument.js";
import {
  addFormOption,
  addFormQuestion,
  formCollabAdapter,
  moveFormQuestion,
  patchFormQuestion,
  readForm,
  removeFormQuestion,
  repairQuestionIds,
  seedForm,
  seedFormSnapshot,
  serializeForm,
  setFormOptionLabel,
  setFormTitle,
} from "./formYDoc.js";

describe("formYDoc", () => {
  it("round-trips a form, including fields the editor does not draw", () => {
    const raw = JSON.stringify({
      version: 1,
      title: "RSVP",
      description: "Saturday",
      extra: { keep: true },
      settings: {
        collecting: false,
        thankYou: "See you there",
        closeOn: "2026-09-25",
        maxResponses: 12,
        theme: "later",
      },
      questions: [
        {
          v: 1,
          id: "q_1",
          type: "choice",
          label: "Coming?",
          help: "One pick",
          required: true,
          image: "photos/cake.jpg",
          imageAlt: "A layered cake",
          config: { options: ["Yes", "No"], allowOther: true },
          logic: { questionId: "q_0", equals: "yes" },
        },
      ],
    });
    const doc = new Y.Doc();
    seedForm(doc, raw);
    const again = serializeForm(doc);
    expect(again).toBe(seedFormSnapshot(raw));
    const read = readForm(doc);
    expect(read.title).toBe("RSVP");
    expect(read.extra).toEqual({ keep: true });
    expect(read.settings.collecting).toBe(false);
    expect(read.settings.thankYou).toBe("See you there");
    expect(read.settings.closeOn).toBe("2026-09-25");
    expect(read.settings.maxResponses).toBe(12);
    expect(read.settings.theme).toBe("later");
    expect(read.settings.allowEdits).toBe(true);
    expect(read.questions[0].help).toBe("One pick");
    expect(read.questions[0].image).toBe("photos/cake.jpg");
    expect(read.questions[0].imageAlt).toBe("A layered cake");
    expect(read.questions[0].config.allowOther).toBe(true);
    expect(read.questions[0].config.options).toEqual(["Yes", "No"]);
    expect(read.questions[0].logic).toEqual({ questionId: "q_0", equals: "yes" });
    doc.destroy();
  });

  it("patches one question and leaves the other alone", () => {
    const doc = new Y.Doc();
    seedForm(doc, serializeFormDocument(blankFormDocument("Hi")));
    addFormQuestion(doc, { v: 1, id: "a", type: "short_text", label: "A", config: {} });
    addFormQuestion(doc, { v: 1, id: "b", type: "number", label: "B", config: { min: 1, max: 5 } });
    patchFormQuestion(doc, "a", { label: "Name", help: "First name", required: true });
    setFormTitle(doc, "Hello");
    const read = readForm(doc);
    expect(read.title).toBe("Hello");
    expect(read.questions.map((q) => q.id)).toEqual(["a", "b"]);
    expect(read.questions[0].label).toBe("Name");
    expect(read.questions[0].help).toBe("First name");
    expect(read.questions[0].required).toBe(true);
    expect(read.questions[1].config).toEqual({ min: 1, max: 5 });
    expect(read.settings.maxResponses).toBe(null);
    doc.destroy();
  });

  it("seeds a solo collab session from the file", () => {
    const raw = serializeFormDocument(blankFormDocument("Hi"));
    const sync = new CollabDocSync({
      driveId: "d",
      path: "hi.lunaform",
      solo: true,
      adapter: formCollabAdapter(),
    });
    sync.connect();
    sync.adoptContent(raw);
    expect(sync.hydrated).toBe(true);
    expect(sync.serialize()).toBe(seedFormSnapshot(raw));
    sync.destroy();
  });

  it("moves a question without losing anything on it", () => {
    const doc = new Y.Doc();
    seedForm(doc, serializeFormDocument(blankFormDocument("Hi")));
    addFormQuestion(doc, {
      v: 1, id: "a", type: "choice", label: "Coming?", help: "Pick one", required: true,
      config: { options: ["Yes", "No"], allowOther: true },
    });
    addFormQuestion(doc, { v: 1, id: "b", type: "long_text", label: "Notes", config: {} });
    const before = readForm(doc, { withIds: true }).questions[0].config.optionIds;
    moveFormQuestion(doc, 0, 1);
    const read = readForm(doc, { withIds: true });
    expect(read.questions.map((q) => q.id)).toEqual(["b", "a"]);
    expect(read.questions[1]).toMatchObject({
      label: "Coming?", help: "Pick one", required: true, type: "choice",
      config: { options: ["Yes", "No"], allowOther: true },
    });
    // Option ids survive so the builder's rows don't remount.
    expect(read.questions[1].config.optionIds).toEqual(before);
    doc.destroy();
  });

  it("drops skip rules that would point forward or at a removed question", () => {
    const doc = new Y.Doc();
    seedForm(doc, serializeFormDocument(blankFormDocument("Hi")));
    addFormQuestion(doc, { v: 1, id: "a", type: "yes_no", label: "Coming?", config: {} });
    addFormQuestion(doc, { v: 1, id: "b", type: "short_text", label: "Meal", config: {}, logic: { questionId: "a", equals: "no" } });
    addFormQuestion(doc, { v: 1, id: "c", type: "short_text", label: "Car", config: {}, logic: { questionId: "a", equals: "no" } });
    moveFormQuestion(doc, 1, 0); // b now before its trigger
    expect(readForm(doc).questions.find((q) => q.id === "b").logic).toBeUndefined();
    const removed = removeFormQuestion(doc, "a");
    expect(removed.index).toBe(1);
    expect(readForm(doc).questions.find((q) => q.id === "c").logic).toBeUndefined();
    // Undo puts it back where it was.
    addFormQuestion(doc, removed.question, removed.index);
    expect(readForm(doc).questions.map((q) => q.id)).toEqual(["b", "a", "c"]);
    doc.destroy();
  });

  it("merges two people typing in the same label", () => {
    const one = new Y.Doc();
    const two = new Y.Doc();
    seedForm(one, serializeFormDocument(blankFormDocument("Hi")));
    addFormQuestion(one, { v: 1, id: "a", type: "choice", label: "Coming", config: { options: ["Yes"] } });
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    patchFormQuestion(one, "a", { label: "Coming Saturday" });
    patchFormQuestion(two, "a", { label: "Are you Coming" });
    const optionId = readForm(one, { withIds: true }).questions[0].config.optionIds[0];
    setFormOptionLabel(one, "a", optionId, "Yes!");
    addFormOption(two, "a", "No");
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    const a = readForm(one).questions[0];
    expect(a.label).toBe("Are you Coming Saturday");
    expect(a.config.options).toEqual(["Yes!", "No"]);
    expect(serializeForm(one)).toBe(serializeForm(two));
    one.destroy();
    two.destroy();
  });

  it("gives questions that share an id their own", () => {
    const doc = new Y.Doc();
    seedForm(doc, JSON.stringify({
      version: 1,
      questions: [
        { id: "", type: "long_text", label: "One" },
        { id: "", type: "long_text", label: "Two" },
        { id: "q_1", type: "short_text", label: "Three" },
        { id: "q_1", type: "short_text", label: "Four" },
      ],
    }));
    let n = 0;
    expect(repairQuestionIds(doc, () => `q_new${(n += 1)}`)).toBe(true);
    const ids = readForm(doc).questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[2]).toBe("q_1");
    expect(repairQuestionIds(doc, () => "unused")).toBe(false);
    doc.destroy();
  });
});
