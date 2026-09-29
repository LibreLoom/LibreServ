import { afterEach, describe, expect, it } from "vitest";
import { findContrastProblems } from "./contrast.js";

function mount(html) {
  document.body.innerHTML = html;
  return document.body;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findContrastProblems", () => {
  it("flags an icon that inherits the outer text color inside a new background", () => {
    // The search well: bg set on the wrapper, text color only on the input.
    const root = mount(`
      <div class="surface-secondary">
        <div class="bg-primary rounded-pill">
          <svg class="lucide-search"></svg>
          <input class="bg-transparent text-secondary" />
        </div>
      </div>`);
    const problems = findContrastProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/lucide-search/);
  });

  it("flags text colored for the card when an inner panel changes the surface", () => {
    // The login error: text-primary picked for the card, but it sits in a
    // bg-primary panel further in.
    const root = mount(`
      <div class="bg-secondary text-primary">
        <div class="bg-primary text-secondary">
          <p class="text-primary">That username or password is wrong.</p>
        </div>
      </div>`);
    expect(findContrastProblems(root)).toHaveLength(1);
  });

  it("passes matched surfaces and inherited colors", () => {
    const root = mount(`
      <div class="surface-secondary">
        <p>Card text</p>
        <div class="surface-primary"><span>Panel text</span><svg></svg></div>
        <div class="bg-primary text-secondary"><span>Old-style pair</span></div>
      </div>`);
    expect(findContrastProblems(root)).toEqual([]);
  });

  it("looks through tints to the surface behind them", () => {
    const root = mount(`
      <div class="surface-secondary">
        <span class="bg-warning/20 border-warning/30 text-secondary">3 warnings</span>
      </div>`);
    expect(findContrastProblems(root)).toHaveLength(1);
  });

  it("lets a single text utility override the surface's color on the same element", () => {
    const root = mount(`<div class="surface-primary text-primary">invisible</div>`);
    expect(findContrastProblems(root)).toHaveLength(1);
  });

  it("uses a declared surface for backgrounds painted by a sibling", () => {
    const root = mount(`
      <div class="surface-secondary">
        <div class="bg-primary absolute"></div>
        <button class="text-secondary" data-contrast-surface="primary">Selected</button>
      </div>`);
    expect(findContrastProblems(root)).toEqual([]);
  });

  it("skips hidden text, unknown surfaces, and opted-out subtrees", () => {
    const root = mount(`
      <div class="surface-secondary">
        <span class="sr-only text-secondary">hidden</span>
        <svg class="opacity-0 text-secondary"></svg>
        <div class="bg-accent"><span class="text-secondary">accent</span></div>
        <div data-contrast-skip><span class="text-secondary">skipped</span></div>
      </div>
      <p class="text-primary">no surface rendered around me</p>`);
    expect(findContrastProblems(root)).toEqual([]);
  });
});
