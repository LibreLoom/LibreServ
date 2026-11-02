import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PhraseWriteDown from "./PhraseWriteDown.jsx";
import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";

function renderWriteDown(props = {}) {
  const onSave = props.onSave || vi.fn(async () => {});
  render(
    <div className="surface-secondary">
      <PhraseWriteDown surface="secondary" onSave={onSave} {...props} />
    </div>,
  );
  return { onSave };
}

/** The words shown on screen, in order. */
function shownWords() {
  return within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent.trim().replace(/^\d+\.\s*/, ""));
}

/** The positions (1-based) the confirm step asks for. */
const askedPositions = () => screen.getAllByRole("textbox").map((i) => Number(i.getAttribute("aria-label").replace("Word ", "")));

async function answer(user, words, overrides = {}) {
  for (const n of askedPositions()) {
    await user.type(screen.getByLabelText(`Word ${n}`), overrides[n] ?? words[n - 1]);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PhraseWriteDown", () => {
  it("shows 12 numbered words with the heading, the lead and the leave warning", () => {
    renderWriteDown();
    expect(screen.getByRole("heading", { name: "Write down your recovery phrase" })).toBeInTheDocument();
    expect(shownWords()).toHaveLength(12);
    expect(screen.getByText(/locks your/)).toBeInTheDocument();
    expect(screen.getByText("cloud backups")).toBeInTheDocument();
    expect(
      screen.getByText("Write these 12 words on paper, in order. If you lose them, no one can open your cloud backups for you, including us."),
    ).toBeInTheDocument();
    expect(screen.getByText("12 words are enough for most people.")).toBeInTheDocument();
    expect(screen.getByText("Leaving this page before you finish makes a new phrase.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I wrote it down" })).toBeInTheDocument();
  });

  it("switches to a fresh 24-word phrase", async () => {
    const user = userEvent.setup();
    renderWriteDown();
    const twelve = shownWords();
    await user.click(screen.getByRole("radio", { name: "24 words" }));
    const words = shownWords();
    expect(words).toHaveLength(24);
    expect(words.slice(0, 12)).not.toEqual(twelve);
    expect(screen.getByText(/Write these 24 words on paper/)).toBeInTheDocument();
  });

  it("goes to the confirm step, which asks for three words by position", async () => {
    const user = userEvent.setup();
    renderWriteDown();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    expect(screen.getByRole("heading", { name: "Confirm your recovery phrase" })).toBeInTheDocument();
    const nums = askedPositions();
    expect(nums).toHaveLength(3);
    expect(screen.getByText(`Type words ${nums[0]}, ${nums[1]} and ${nums[2]} from what you wrote down.`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the phrase" }));
    expect(screen.getByRole("button", { name: "I wrote it down" })).toBeInTheDocument();
  });

  it("a wrong word shakes with its line, focuses that box and does not save", async () => {
    const user = userEvent.setup();
    const { onSave } = renderWriteDown();
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    const [first] = askedPositions();
    const wrong = words[first - 1] === "abandon" ? "about" : "abandon";
    await answer(user, words, { [first]: wrong });
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText(`Word ${first} doesn't match. Check what you wrote down.`)).toBeInTheDocument();
    expect(screen.getByLabelText(`Word ${first}`)).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the right words call onSave with the phrase's entropy", async () => {
    const user = userEvent.setup();
    const { onSave } = renderWriteDown({ saveLabel: "Save recovery phrase" });
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    await answer(user, words);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual(phraseToEntropy(words.join(" ")));
  });

  it("shows the message from a failed save and stays on the confirm step", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => { throw new Error("Luna could not reach its database."); });
    renderWriteDown({ onSave });
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    await answer(user, words);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Luna could not reach its database.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
  });

  it("asks before the tab closes until the phrase is saved", async () => {
    const user = userEvent.setup();
    renderWriteDown();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    await answer(user, words);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => {
      const later = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
    });
  });

  it("reports the step to the caller and can leave its headings out", async () => {
    const user = userEvent.setup();
    const onStepChange = vi.fn();
    renderWriteDown({ titles: { show: "", confirm: "" }, onStepChange });
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    expect(onStepChange).toHaveBeenCalledWith("confirm");
  });

  it("prints, downloads and copies the phrase", async () => {
    const user = userEvent.setup();
    /** @type {any} */
    const win = { document: { write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(win);
    renderWriteDown();
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(win.document.write.mock.calls[0][0]).toContain(`<li>1. ${words[0]}</li>`);
    expect(win.print).toHaveBeenCalled();

    const createObjectURL = vi.fn((/** @type {Blob} */ _blob) => "blob:phrase");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Download" }));
    const text = await createObjectURL.mock.calls[0][0].text();
    expect(text).toContain(`1. ${words[0]}`);
    expect(text).toContain(`12. ${words[11]}`);
  });

  it("explains how to print when the browser blocks the print window", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    renderWriteDown();
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(
      await screen.findByText("Could not open the print window. Allow pop-ups for Luna, or use Download."),
    ).toBeInTheDocument();
  });
});
