import { describe, expect, it } from "vitest";
import { comboKeycaps, isEditableTarget, matchesCombo, parseCombo } from "./shortcuts.js";

/** @param {KeyboardEventInit} init */
const key = (init) => new KeyboardEvent("keydown", init);

describe("matchesCombo", () => {
  it("matches a bare key and ignores it when a modifier is held", () => {
    const combo = parseCombo("n");
    expect(matchesCombo(key({ key: "n" }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "N", shiftKey: true }), combo)).toBe(false);
    expect(matchesCombo(key({ key: "n", ctrlKey: true }), combo)).toBe(false);
    expect(matchesCombo(key({ key: "n", altKey: true }), combo)).toBe(false);
  });

  it("matches ? although it needs Shift to type", () => {
    expect(matchesCombo(key({ key: "?", shiftKey: true }), parseCombo("?"))).toBe(true);
  });

  it("matches Alt combos by physical key, so Mac Option still works", () => {
    const combo = parseCombo("Alt+Shift+1");
    expect(matchesCombo(key({ key: "¡", code: "Digit1", altKey: true, shiftKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "1", code: "Digit1", altKey: true }), combo)).toBe(false);
    expect(matchesCombo(key({ key: "2", code: "Digit2", altKey: true, shiftKey: true }), combo)).toBe(false);
  });

  it("keeps Alt+/ and Alt+Shift+/ apart", () => {
    const combo = parseCombo("Alt+/");
    expect(matchesCombo(key({ key: "/", code: "Slash", altKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "?", code: "Slash", altKey: true, shiftKey: true }), combo)).toBe(false);
  });

  it("treats Mod as Ctrl or ⌘", () => {
    const combo = parseCombo("Mod+Enter");
    expect(matchesCombo(key({ key: "Enter", ctrlKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "Enter", metaKey: true }), combo)).toBe(true);
    expect(matchesCombo(key({ key: "Enter" }), combo)).toBe(false);
  });

  it("reads named keys", () => {
    expect(matchesCombo(key({ key: "Delete" }), parseCombo("Delete"))).toBe(true);
    expect(matchesCombo(key({ key: " " }), parseCombo("Space"))).toBe(true);
    expect(matchesCombo(key({ key: "F2" }), parseCombo("F2"))).toBe(true);
  });
});

describe("comboKeycaps", () => {
  it("names modifiers for the platform", () => {
    expect(comboKeycaps("Alt+Shift+1", { mac: false })).toEqual(["Alt", "Shift", "1"]);
    expect(comboKeycaps("Alt+Shift+1", { mac: true })).toEqual(["Option", "Shift", "1"]);
    expect(comboKeycaps("Mod+A", { mac: true })).toEqual(["⌘", "A"]);
    expect(comboKeycaps("Mod+A", { mac: false })).toEqual(["Ctrl", "A"]);
    expect(comboKeycaps("Escape")).toEqual(["Esc"]);
  });
});

describe("isEditableTarget", () => {
  it("is true for text fields and false for buttons and checkboxes", () => {
    const input = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(box)).toBe(false);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
  });
});
