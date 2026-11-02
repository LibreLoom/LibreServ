import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PhraseReplaceFlow from "./PhraseReplaceFlow.jsx";
import { entropyToPhrase, newEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";

const MAY_HAVE_IT =
  "Your old phrase stops working right away. Luna then moves your cloud backups to the new phrase in the background, which can take days. Until it finishes, someone who already used your old phrase could still open files that haven't changed.";

function setup(props = {}) {
  const onProve = props.onProve || vi.fn(async () => true);
  const onSave = vi.fn();
  const onClose = vi.fn();
  const utils = render(<PhraseReplaceFlow kind="change" onProve={onProve} onSave={onSave} onClose={onClose} {...props} />);
  return { onProve, onSave, onClose, ...utils };
}

async function pasteOldPhrase(user) {
  const phrase = entropyToPhrase(newEntropy(12));
  await user.click(screen.getByLabelText("Word 1"));
  await user.paste(phrase);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return phrase;
}

/** Reads the shown new phrase, taps "I wrote it down" and types the three asked words. */
async function confirmNewPhrase(user) {
  const items = screen.getAllByRole("listitem").map((li) => li.textContent.replace(/^\d+\./, ""));
  await user.click(screen.getByRole("button", { name: "I wrote it down" }));
  for (const input of screen.getAllByRole("textbox")) {
    const n = Number(input.getAttribute("aria-label").replace("Word ", ""));
    await user.type(input, items[n - 1]);
  }
  return items.join(" ");
}

describe("PhraseReplaceFlow, change", () => {
  it("starts by checking the old phrase", () => {
    setup();
    expect(screen.getByText("Enter your current phrase")).toBeInTheDocument();
  });

  it("refuses a wrong old phrase inline and stays on the check", async () => {
    const user = userEvent.setup();
    setup({ onProve: vi.fn(async () => false) });
    await pasteOldPhrase(user);
    expect(await screen.findByText(/That isn't the recovery phrase for your account/)).toBeInTheDocument();
    expect(screen.queryByText("Could someone else have your phrase?")).not.toBeInTheDocument();
  });

  it("shows a locked-out message from the caller inline", () => {
    setup({ error: "Too many wrong tries. Try again in 10 minutes." });
    expect(screen.getByText("Too many wrong tries. Try again in 10 minutes.")).toBeInTheDocument();
  });

  it("passes the old phrase to onProve, then asks the question with change wording", async () => {
    const user = userEvent.setup();
    const { onProve } = setup();
    const phrase = await pasteOldPhrase(user);
    expect(await screen.findByText("Could someone else have your phrase?")).toBeInTheDocument();
    expect(onProve).toHaveBeenCalledWith({ phrase });
    expect(screen.getByRole("button", { name: "No, it's only mine" })).toBeInTheDocument();
    expect(screen.getByText("Someone may have it", { selector: "button *, button" })).toBeInTheDocument();
  });

  it("shows the 'may have it' text and the Connect note, with no interim private-history lines", async () => {
    const user = userEvent.setup();
    setup();
    await pasteOldPhrase(user);
    await screen.findByText("Could someone else have your phrase?");
    expect(screen.getByText(MAY_HAVE_IT)).toBeInTheDocument();
    expect(screen.getByText(/old phrase alone does not open backups on Connect/)).toBeInTheDocument();
    expect(screen.queryByText(/stay with your old phrase for 30 days/)).not.toBeInTheDocument();
    expect(screen.queryByText(/back up again from the start/)).not.toBeInTheDocument();
    expect(screen.queryByText("Older versions of your private items can't be kept.")).not.toBeInTheDocument();
    expect(screen.queryByText(/private items/)).not.toBeInTheDocument();
  });

  it("answer 'No' saves exposed: false with the new phrase shown", async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    const newPhrase = await confirmNewPhrase(user);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
    expect(onSave).toHaveBeenCalledWith({ exposed: false, newPhrase });
  });

  it("answer 'Someone may have it' saves exposed: true", async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: /Someone may have it/ }));
    const newPhrase = await confirmNewPhrase(user);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
    expect(onSave).toHaveBeenCalledWith({ exposed: true, newPhrase });
  });

  it("offers 12 or 24 words for the new phrase", async () => {
    const user = userEvent.setup();
    setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    await user.click(screen.getByRole("radio", { name: "24 words" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(24);
  });

  it("passes the phrase length to the check, so a 24-word phrase gets 24 boxes", () => {
    setup({ words: 24 });
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
  });

  it("offers 'Lost your phrase?' after a refused old phrase and hands it to the caller", async () => {
    const user = userEvent.setup();
    const onLost = vi.fn();
    setup({ onProve: vi.fn(async () => false), onLost });
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "Lost your phrase?" }));
    expect(onLost).toHaveBeenCalled();
  });

  it("titles the new-phrase step, then the confirm step", async () => {
    const user = userEvent.setup();
    setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    expect(screen.getByText("Your new recovery phrase")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    expect(screen.getByText("Confirm your new phrase")).toBeInTheDocument();
  });

  it("refuses a wrong confirm word without saving", async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
    expect(await screen.findByText(/doesn't match. Check what you wrote down./)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saving: disables the save button while busy", async () => {
    const user = userEvent.setup();
    const { rerender, onProve, onSave, onClose } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    rerender(<PhraseReplaceFlow kind="change" onProve={onProve} onSave={onSave} onClose={onClose} busy />);
    expect(screen.getByRole("button", { name: /Save recovery phrase/ })).toBeDisabled();
  });

  it("save failed: shows the caller's error inline on the confirm step", async () => {
    const user = userEvent.setup();
    const { rerender, onProve, onSave, onClose } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    await user.click(screen.getByRole("button", { name: "I wrote it down" }));
    rerender(<PhraseReplaceFlow kind="change" onProve={onProve} onSave={onSave} onClose={onClose} error="Could not save your recovery phrase. Try again." />);
    expect(screen.getByText("Could not save your recovery phrase. Try again.")).toBeInTheDocument();
  });

  it("never writes the new phrase to the console", async () => {
    const user = userEvent.setup();
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")].map((spy) => spy.mockImplementation(() => {}));
    setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    const first = screen.getAllByRole("listitem")[0].textContent.replace(/^\d+\./, "");
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(first);
      spy.mockRestore();
    }
  });

  it("wipes the new phrase when closed and reopened", async () => {
    const user = userEvent.setup();
    const { rerender, onProve, onSave, onClose } = setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: "No, it's only mine" }));
    rerender(<PhraseReplaceFlow kind="change" open={false} onProve={onProve} onSave={onSave} onClose={onClose} />);
    rerender(<PhraseReplaceFlow kind="change" onProve={onProve} onSave={onSave} onClose={onClose} />);
    expect(await screen.findByText("Enter your current phrase")).toBeInTheDocument();
  });
});

describe("PhraseReplaceFlow, delete older private versions", () => {
  const baseProps = { kind: "change", onProve: async () => true, onSave: () => {}, onClose: () => {} };

  it("is not shown before the save, whatever the answer", async () => {
    const user = userEvent.setup();
    setup();
    await pasteOldPhrase(user);
    await user.click(await screen.findByRole("button", { name: /Someone may have it/ }));
    expect(screen.queryByText("Delete older private versions?")).not.toBeInTheDocument();
  });

  it("names what is lost and says skipping keeps them", () => {
    render(<PhraseReplaceFlow {...baseProps} saved onRetire={vi.fn()} />);
    expect(screen.getByText("Delete older private versions?")).toBeInTheDocument();
    expect(screen.getByText(/earlier versions of your private items, and files you deleted that exist only in the cloud/)).toBeInTheDocument();
    expect(screen.getByText(/Luna keeps them, and your old phrase may still open them/)).toBeInTheDocument();
  });

  it("deleting calls onRetire once", async () => {
    const user = userEvent.setup();
    const onRetire = vi.fn();
    render(<PhraseReplaceFlow {...baseProps} saved onRetire={onRetire} />);
    await user.click(screen.getByRole("button", { name: "Delete older versions" }));
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it("skipping closes without calling onRetire", async () => {
    const user = userEvent.setup();
    const onRetire = vi.fn();
    const onClose = vi.fn();
    render(<PhraseReplaceFlow {...baseProps} onClose={onClose} saved onRetire={onRetire} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onRetire).not.toHaveBeenCalled();
  });

  it("shows the caller's error inline in the modal", () => {
    render(<PhraseReplaceFlow {...baseProps} saved onRetire={vi.fn()} retireError="Could not delete the older private versions. Try again." />);
    expect(screen.getByText("Could not delete the older private versions. Try again.")).toBeInTheDocument();
    expect(screen.getByText("Delete older private versions?")).toBeInTheDocument();
  });

  it("does not call onRetire again while deleting", async () => {
    const user = userEvent.setup();
    const onRetire = vi.fn();
    render(<PhraseReplaceFlow {...baseProps} saved retiring onRetire={onRetire} />);
    await user.click(screen.getByRole("button", { name: /Processing/ }));
    expect(onRetire).not.toHaveBeenCalled();
  });
});

describe("PhraseReplaceFlow, lost", () => {
  async function toQuestion(user) {
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Could someone else have your phrase?");
  }
  const lost = (props = {}) => setup({ kind: "lost", ...props });

  it("opens with a confirm that names what is lost", () => {
    lost();
    expect(screen.getByText("Get a new phrase?")).toBeInTheDocument();
    expect(screen.getByText("Private items backed up with your old phrase can't be opened anymore.")).toBeInTheDocument();
    expect(screen.getByText("Your shared cloud backups stay open to you with the new phrase.")).toBeInTheDocument();
  });

  it("closing the confirm calls onClose without proving anything", async () => {
    const user = userEvent.setup();
    const { onClose, onProve } = lost();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onProve).not.toHaveBeenCalled();
  });

  it("asks the question with lost wording and the lost private lines", async () => {
    const user = userEvent.setup();
    lost();
    await toQuestion(user);
    expect(screen.getByRole("button", { name: "No, it's just lost" })).toBeInTheDocument();
    expect(screen.getByText(/Luna keeps your older private items for 30 days/)).toBeInTheDocument();
    expect(screen.getByText("Luna removes your older private items now.")).toBeInTheDocument();
    expect(screen.getByText(MAY_HAVE_IT)).toBeInTheDocument();
  });

  it.each(["No, it's just lost", "Someone may have it"])("never offers the delete step in the lost flow (%s)", async (label) => {
    const user = userEvent.setup();
    lost();
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: label }));
    expect(screen.queryByText("Delete older private versions?")).not.toBeInTheDocument();
  });

  it("password field is a password input, autocomplete off, cleared after submit", async () => {
    const user = userEvent.setup();
    const { onProve } = lost();
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: "No, it's just lost" }));
    const field = screen.getByLabelText("Your Luna password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    await user.type(field, "hunter2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onProve).toHaveBeenCalledWith({ password: "hunter2" });
    await screen.findByText("Your new recovery phrase");
  });

  it("wrong password is refused inline and the field is cleared", async () => {
    const user = userEvent.setup();
    lost({ onProve: vi.fn(async () => false) });
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: "Someone may have it" }));
    await user.type(screen.getByLabelText("Your Luna password"), "nope");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That is not your Luna password. Try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Your Luna password")).toHaveValue("");
  });

  it("shows the caller's locked-out message on the password step", async () => {
    const user = userEvent.setup();
    lost({ error: "Too many wrong tries. Try again in 10 minutes." });
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: "No, it's just lost" }));
    expect(screen.getByText("Too many wrong tries. Try again in 10 minutes.")).toBeInTheDocument();
  });

  it("a thrown error from onProve shows inline", async () => {
    const user = userEvent.setup();
    lost({ onProve: vi.fn(async () => { throw new Error("Could not reach Luna."); }) });
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: "No, it's just lost" }));
    await user.type(screen.getByLabelText("Your Luna password"), "x");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Could not reach Luna.")).toBeInTheDocument();
  });

  it.each([
    ["No, it's just lost", false],
    ["Someone may have it", true],
  ])("answer %s saves exposed: %s", async (label, exposed) => {
    const user = userEvent.setup();
    const { onSave } = lost();
    await toQuestion(user);
    await user.click(screen.getByRole("button", { name: label }));
    await user.type(screen.getByLabelText("Your Luna password"), "pw");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Your new recovery phrase");
    const newPhrase = await confirmNewPhrase(user);
    await user.click(screen.getByRole("button", { name: "Save recovery phrase" }));
    expect(onSave).toHaveBeenCalledWith({ exposed, newPhrase });
  });
});

describe("PhraseReplaceFlow, refused password and double save", () => {
  const props = { kind: "lost", onProve: async () => true, onSave: () => {}, onClose: () => {} };

  async function toConfirm(user, onSave) {
    const utils = render(<PhraseReplaceFlow {...props} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "No, it's just lost" }));
    await user.type(screen.getByLabelText("Your Luna password"), "wrong one");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Your new recovery phrase");
    return utils;
  }

  it("goes back to the password step, empty, with the new phrase dropped, when the password is refused", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = await toConfirm(user, onSave);
    const before = screen.getAllByRole("listitem").map((li) => li.textContent).join(" ");
    rerender(<PhraseReplaceFlow {...props} onSave={onSave} error="That is not your Luna password. Try again." passwordRetry={1} />);
    expect(await screen.findByLabelText("Your Luna password")).toHaveValue("");
    expect(screen.getByText("That is not your Luna password. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Your new recovery phrase")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Your Luna password"), "right one");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Your new recovery phrase");
    const after = screen.getAllByRole("listitem").map((li) => li.textContent).join(" ");
    expect(after).not.toBe(before);
  });

  it("sends one save when the form is submitted twice before the caller answers", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    await toConfirm(user, onSave);
    await confirmNewPhrase(user);
    const form = screen.getByRole("button", { name: "Save recovery phrase" }).closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
