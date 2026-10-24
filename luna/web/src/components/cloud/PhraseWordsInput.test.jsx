import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { blankWords } from "../../lib/cloudPhrase";
import PhraseWordsInput from "./PhraseWordsInput.jsx";

const TWELVE = [...Array(11).fill("abandon"), "about"];

/** Holds the words and the count the way a dialog does, on a card. */
function Harness({ initialCount = 12, lengthKnown = false }) {
  const [count, setCount] = useState(initialCount);
  const [words, setWords] = useState(blankWords);
  return (
    <div className="surface-secondary">
      <PhraseWordsInput
        count={count}
        words={words}
        onChange={setWords}
        onCountChange={setCount}
        lengthKnown={lengthKnown}
      />
    </div>
  );
}

const values = () => screen.getAllByRole("textbox").map((b) => /** @type {HTMLInputElement} */ (b).value);

async function pasteInto(user, index, text) {
  await user.click(screen.getByLabelText(`Word ${index}`));
  await user.paste(text);
}

describe("PhraseWordsInput", () => {
  it("fills all 12 boxes from the downloaded file's numbered lines", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const text = TWELVE.map((w, i) => `${i + 1}. ${w}`).join("\n");
    await pasteInto(user, 1, text);
    expect(values()).toEqual(TWELVE);
  });

  it("switches to 24 boxes when 24 words are pasted and the length is unknown", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pasteInto(user, 1, Array(24).fill("abandon").join(" "));
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    expect(screen.getByRole("radio", { name: "24 words" })).toBeChecked();
  });

  it("refuses 24 pasted words when the phrase is known to have 12, and says why", async () => {
    const user = userEvent.setup();
    render(<Harness lengthKnown />);
    await pasteInto(user, 1, Array(24).fill("abandon").join(" "));
    expect(screen.getAllByRole("textbox")).toHaveLength(12);
    expect(values().every((v) => v === "")).toBe(true);
    expect(screen.getByText("That's 24 words. Your recovery phrase has 12.")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "24 words" })).not.toBeInTheDocument();
  });

  it("marks a word that is not on the list and says which one", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Word 2"), "zzzz");
    expect(screen.getByLabelText("Word 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Word 2 isn't on the recovery phrase list. Check the spelling.")).toBeInTheDocument();
  });

  it("names several words that are not on the list together", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Word 4"), "zzzz");
    await user.type(screen.getByLabelText("Word 9"), "qqqq");
    await user.click(screen.getByLabelText("Word 1"));
    expect(screen.getByText("Words 4 and 9 aren't on the recovery phrase list. Check the spelling.")).toBeInTheDocument();
  });

  it("highlights the one word that fits what is typed; Space takes it and moves on", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Word 1"), "aban");
    expect(screen.getByRole("button", { name: "abandon" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(screen.getByLabelText("Word 1")).toHaveValue("abandon");
    expect(screen.getByLabelText("Word 2")).toHaveFocus();
  });

  it("moves back to the previous box on Backspace in an empty box", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Word 1"), "abandon");
    await user.click(screen.getByLabelText("Word 2"));
    await user.keyboard("{Backspace}");
    expect(screen.getByLabelText("Word 1")).toHaveFocus();
  });

  it("ArrowDown then Enter takes a chip and moves on", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Word 1"), "ab");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const chosen = screen.getAllByRole("button", { pressed: true })[0].textContent;
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Word 1")).toHaveValue(chosen);
    expect(screen.getByLabelText("Word 2")).toHaveFocus();
  });

  it("shows the hint only in box 1", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Word 1")).toHaveAttribute("placeholder", "Type or paste");
    expect(screen.getByLabelText("Word 2")).not.toHaveAttribute("placeholder");
  });
});
