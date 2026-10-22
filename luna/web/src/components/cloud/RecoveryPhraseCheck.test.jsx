import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RecoveryPhraseCheck from "./RecoveryPhraseCheck.jsx";
import { entropyToPhrase, newEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";

function setup(props = {}) {
  const verify = props.verify || vi.fn(async () => true);
  const onClose = vi.fn();
  const utils = render(<RecoveryPhraseCheck onClose={onClose} verify={verify} {...props} />);
  return { verify, onClose, ...utils };
}

async function pasteInto(user, index, text) {
  await user.click(screen.getByLabelText(`Word ${index}`));
  await user.paste(text);
}

const submit = (user) => user.click(screen.getByRole("button", { name: "Check" }));

describe("RecoveryPhraseCheck", () => {
  it("idle: titled 'Check my phrase' with 12 empty boxes and the button disabled", () => {
    setup();
    expect(screen.getByText("Check my phrase")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  });

  it("spreads a pasted 12-word phrase across the boxes and keeps 12", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    setup();
    await pasteInto(user, 1, phrase);
    const boxes = screen.getAllByRole("textbox");
    expect(boxes.map((b) => /** @type {HTMLInputElement} */ (b).value).join(" ")).toBe(phrase);
    expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
  });

  it("switches to 24 boxes when 24 words are pasted", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(24));
    setup();
    await pasteInto(user, 1, phrase);
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    expect(screen.getAllByRole("textbox").map((b) => /** @type {HTMLInputElement} */ (b).value).join(" ")).toBe(phrase);
  });

  it("the 12/24 switch changes the number of boxes", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("radio", { name: "24 words" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    await user.click(screen.getByRole("radio", { name: "12 words" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(12);
  });

  it("suggests words from the list as you type and fills the box when one is picked", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Word 1"), "aban");
    await user.click(await screen.findByRole("button", { name: "abandon" }));
    expect(screen.getByLabelText("Word 1")).toHaveValue("abandon");
  });

  it("marks a box invalid, with a plain note, when its word is not on the list", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Word 3"), "zzzz");
    await user.click(screen.getByLabelText("Word 4"));
    expect(screen.getByLabelText("Word 3")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Word 3 is not on the recovery phrase list. Check the spelling.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  });

  it("does not call verify when the words are on the list but the phrase is invalid", async () => {
    const user = userEvent.setup();
    const { verify } = setup();
    await pasteInto(user, 1, Array(12).fill("abandon").join(" "));
    await submit(user);
    expect(await screen.findByText(/don't form a valid recovery phrase/)).toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });

  it("check mode: a right phrase shows a clear match and wipes the boxes", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    const { verify } = setup();
    await pasteInto(user, 1, phrase);
    await submit(user);
    expect(await screen.findByText("Your phrase matches. You have the right recovery phrase.")).toBeInTheDocument();
    expect(verify).toHaveBeenCalledWith(phrase);
    expect(screen.getByLabelText("Word 1")).toHaveValue("");
  });

  it("step mode: hands the phrase to onVerified without showing a match", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    const onVerified = vi.fn();
    setup({ mode: "step", onVerified });
    await pasteInto(user, 1, phrase);
    await submit(user);
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(phrase));
    expect(screen.queryByText(/Your phrase matches/)).not.toBeInTheDocument();
  });

  it("a wrong phrase is refused inline and onVerified is not called", async () => {
    const user = userEvent.setup();
    const onVerified = vi.fn();
    setup({ verify: vi.fn(async () => false), onVerified, mode: "step" });
    await pasteInto(user, 1, entropyToPhrase(newEntropy(12)));
    await submit(user);
    expect(await screen.findByText(/not the recovery phrase set up on this Luna/)).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("shows the error when verify fails, and the caller's own message", async () => {
    const user = userEvent.setup();
    setup({ verify: vi.fn(async () => { throw new Error("Too many tries. Wait 10 minutes."); }) });
    await pasteInto(user, 1, entropyToPhrase(newEntropy(12)));
    await submit(user);
    expect(await screen.findByText("Too many tries. Wait 10 minutes.")).toBeInTheDocument();
  });

  it("shows an error passed in by the caller", () => {
    setup({ error: "Too many tries. Wait 10 minutes." });
    expect(screen.getByText("Too many tries. Wait 10 minutes.")).toBeInTheDocument();
  });

  it("never writes the phrase to the console", async () => {
    const user = userEvent.setup();
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")].map((spy) => spy.mockImplementation(() => {}));
    const phrase = entropyToPhrase(newEntropy(12));
    setup();
    await pasteInto(user, 1, phrase);
    await submit(user);
    await screen.findByText(/Your phrase matches/);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(phrase.split(" ")[0] + " " + phrase.split(" ")[1]);
      spy.mockRestore();
    }
  });

  it("wipes the typed words when the dialog is closed", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    const verify = vi.fn(async () => true);
    const { rerender } = render(<RecoveryPhraseCheck onClose={() => {}} verify={verify} />);
    await pasteInto(user, 1, phrase);
    rerender(<RecoveryPhraseCheck open={false} onClose={() => {}} verify={verify} />);
    rerender(<RecoveryPhraseCheck onClose={() => {}} verify={verify} />);
    expect(screen.getByLabelText("Word 1")).toHaveValue("");
  });
});
