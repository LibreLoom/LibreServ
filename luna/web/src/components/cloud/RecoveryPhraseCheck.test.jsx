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
const values = () => screen.getAllByRole("textbox").map((b) => /** @type {HTMLInputElement} */ (b).value);

describe("RecoveryPhraseCheck", () => {
  it("is titled 'Check my phrase' with 12 empty boxes, a 12/24 switch and a counter", () => {
    setup();
    expect(screen.getByText("Check my phrase")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(12);
    expect(screen.getByRole("radio", { name: "12 words" })).toBeInTheDocument();
    expect(screen.getByText("0 of 12")).toBeInTheDocument();
    expect(screen.getByText("Type your recovery phrase in order, from where you wrote it down.")).toBeInTheDocument();
  });

  it("puts focus in box 1 when it opens", async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText("Word 1")).toHaveFocus());
  });

  it("words={24} gives 24 boxes and no switch", () => {
    setup({ words: 24 });
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    expect(screen.queryByRole("radio", { name: "12 words" })).not.toBeInTheDocument();
    expect(screen.getByText("Type your 24 words in order, from where you wrote them down.")).toBeInTheDocument();
  });

  it("submitting with gaps names the first empty word, focuses it, and the button is never disabled", async () => {
    const user = userEvent.setup();
    const { verify } = setup();
    expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
    await submit(user);
    expect(await screen.findByText("Fill in word 1.")).toBeInTheDocument();
    expect(screen.getByLabelText("Word 1")).toHaveFocus();
    expect(verify).not.toHaveBeenCalled();
  });

  it("a word that is not on the list is flagged and focused, without asking Luna", async () => {
    const user = userEvent.setup();
    const { verify } = setup();
    await pasteInto(user, 1, [...Array(11).fill("abandon"), "zzzz"].join(" "));
    await submit(user);
    expect(screen.getByLabelText("Word 12")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Word 12 isn't on the recovery phrase list. Check the spelling.")).toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });

  it("a bad checksum shows its line and never calls verify", async () => {
    const user = userEvent.setup();
    const { verify } = setup();
    await pasteInto(user, 1, Array(12).fill("abandon").join(" "));
    await submit(user);
    expect(
      await screen.findByText("These 12 words don't form a recovery phrase. A word may be wrong or out of order."),
    ).toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });

  it("a refused phrase shows the refusal line and 'Lost your phrase?', and keeps the words", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    const onLost = vi.fn();
    setup({ verify: vi.fn(async () => false), onLost });
    expect(screen.queryByRole("button", { name: "Lost your phrase?" })).not.toBeInTheDocument();
    await pasteInto(user, 1, phrase);
    await submit(user);
    expect(
      await screen.findByText("That isn't the recovery phrase for your account. Check each word against what you wrote down."),
    ).toBeInTheDocument();
    expect(values().join(" ")).toBe(phrase);
    await user.click(screen.getByRole("button", { name: "Lost your phrase?" }));
    expect(onLost).toHaveBeenCalled();
  });

  it("success calls onVerified with the phrase and wipes the boxes", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    const onVerified = vi.fn();
    const { verify } = setup({ onVerified });
    await pasteInto(user, 1, phrase);
    await submit(user);
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(phrase));
    expect(verify).toHaveBeenCalledWith(phrase);
    expect(screen.queryByText(/Your phrase matches/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Word 1")).toHaveValue("");
  });

  it("shows the message verify throws (a lockout or an expired check) and keeps the words", async () => {
    const user = userEvent.setup();
    const phrase = entropyToPhrase(newEntropy(12));
    setup({ verify: vi.fn(async () => { throw new Error("That check took too long. Start it again."); }) });
    await pasteInto(user, 1, phrase);
    await submit(user);
    expect(await screen.findByText("That check took too long. Start it again.")).toBeInTheDocument();
    expect(values().join(" ")).toBe(phrase);
  });

  it("shows an error passed in by the caller", () => {
    setup({ error: "Too many wrong tries. Wait a few minutes, then try again." });
    expect(screen.getByText("Too many wrong tries. Wait a few minutes, then try again.")).toBeInTheDocument();
  });

  it("fills the boxes from the downloaded file's numbered lines", async () => {
    const user = userEvent.setup();
    const words = entropyToPhrase(newEntropy(12)).split(" ");
    const file = `Luna recovery phrase\n\n${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}\n\nKeep these 12 words somewhere safe.\n`;
    setup();
    await pasteInto(user, 1, file);
    expect(values()).toEqual(words);
    expect(screen.getByText("12 of 12")).toBeInTheDocument();
  });

  it("never writes the phrase to the console", async () => {
    const user = userEvent.setup();
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")].map((spy) => spy.mockImplementation(() => {}));
    const phrase = entropyToPhrase(newEntropy(12));
    const onVerified = vi.fn();
    setup({ onVerified });
    await pasteInto(user, 1, phrase);
    await submit(user);
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
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

  it("keeps the suggestions while focus moves onto one with Tab", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Word 1"), "aban");
    await user.tab();
    expect(screen.getByRole("button", { name: "abandon" })).toHaveFocus();
    expect(screen.getByRole("group", { name: "Suggestions for word 1" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Word 1")).toHaveValue("abandon");
  });
});
