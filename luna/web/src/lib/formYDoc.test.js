import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollabDocSync } from "../components/files/collabDocSync.js";
import {
  blankFormDocument,
  serializeFormDocument,
} from "./formDocument.js";
import {
  addFormQuestion,
  formCollabAdapter,
  patchFormQuestion,
  readForm,
  seedForm,
  seedFormSnapshot,
  serializeForm,
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
        notify: false,
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
    expect(read.settings.notify).toBe(false);
    expect(read.settings.theme).toBe("later");
    expect(read.settings.allowEdits).toBe(true);
    expect(read.questions[0].help).toBe("One pick");
    expect(read.questions[0].image).toBe("photos/cake.jpg");
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
    expect(read.settings.notify).toBe(true);
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
});
