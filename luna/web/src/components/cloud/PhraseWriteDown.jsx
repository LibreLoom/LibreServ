import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AlertCircle } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { entropyToPhrase, newEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import { apiErrorMessage } from "../../lib/api";
import { WordBox } from "./PhraseWordsInput.jsx";

const LENGTH_OPTIONS = [
  { value: "12", label: "12 words" },
  { value: "24", label: "24 words" },
];

const SAVE_FAILED = "Could not save your recovery phrase. Try again.";

/** "words 3, 7 and 11" from 0-based positions. */
function positionsSentence(positions) {
  const nums = positions.map((p) => p + 1);
  return `words ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

/** Three word positions (0-based), one from each third of the phrase, sorted. */
function pickCheckPositions(count) {
  const third = count / 3;
  return [0, 1, 2].map((n) => Math.floor(n * third + Math.random() * third));
}

/** Inline error: the icon carries the red, the words stay plain text. */
function InlineError({ children }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-primary">
      <AlertCircle size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Makes a new recovery phrase, shows it to write down, asks for three of its words back, then hands
 * the phrase's entropy to `onSave`. Not a modal: the caller puts it on a card (`surface`).
 * - `onSave(entropy)` may be async. If it rejects, the message shows here and the person stays on the
 *   confirm step. `busy` / `error` let a caller that saves some other way (a mutation) report the same.
 * - `titles` are the two step headings; a `null` one is left out (a caller that has its own heading).
 * - `intro` replaces the opening sentence (`null` leaves it out).
 * - `onStepChange("show" | "confirm")` tells the caller which step is on screen.
 * The words live only in this component's state. Until the save finishes, closing the tab asks first.
 * @param {{
 *   surface?: "primary" | "secondary",
 *   onSave: (entropy: Uint8Array) => unknown,
 *   saveLabel?: string,
 *   headingLevel?: 2 | 3,
 *   titles?: { show?: string, confirm?: string },
 *   intro?: import("react").ReactNode,
 *   busy?: boolean,
 *   error?: string,
 *   onStepChange?: (step: "show" | "confirm") => void,
 * }} props
 */
export default function PhraseWriteDown({
  surface = "secondary",
  onSave,
  saveLabel = "Save and continue",
  headingLevel = 2,
  titles = { show: "Write down your recovery phrase", confirm: "Confirm your recovery phrase" },
  intro,
  busy = false,
  error: externalError = "",
  onStepChange,
}) {
  const [entropy, setEntropy] = useState(() => newEntropy(12));
  const words = useMemo(() => entropyToPhrase(entropy).split(" "), [entropy]);
  const [step, setStep] = useState("show");
  const [positions, setPositions] = useState(() => pickCheckPositions(12));
  const [answers, setAnswers] = useState(["", "", ""]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const formRef = useRef(null);
  const boxes = useRef(/** @type {Array<HTMLInputElement | null>} */ ([]));

  // Leaving before the phrase is saved makes a new phrase next time, so ask first.
  const guard = !saved || busy;
  useEffect(() => {
    if (!guard) return undefined;
    const handler = (/** @type {BeforeUnloadEvent} */ event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [guard]);

  const Heading = /** @type {any} */ (`h${headingLevel}`);
  const working = saving || busy;
  const shownError = error || externalError;

  function goTo(next) {
    setError("");
    setStep(next);
    onStepChange?.(next);
  }

  /** Make a new phrase of the chosen length. Nothing has been written down yet, so the old phrase is dropped. */
  function chooseLength(value) {
    const count = value === "24" ? 24 : 12;
    if (count === words.length) return;
    setEntropy(newEntropy(count));
    setPositions(pickCheckPositions(count));
    setAnswers(["", "", ""]);
    setCopied(false);
    setError("");
  }

  async function copyWords() {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      setError("Could not copy. Select the phrase and copy it by hand.");
    }
  }

  function printWords() {
    const win = window.open("", "_blank");
    if (!win) {
      setError("Could not open the print window. Allow pop-ups for Luna, or use Download.");
      return;
    }
    const items = words.map((word, i) => `<li>${i + 1}. ${word}</li>`).join("");
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Luna recovery phrase</title></head>` +
        `<body><h1>Luna recovery phrase</h1><ol>${items}</ol>` +
        `<p>Keep these ${words.length} words somewhere safe. Anyone with them can open your cloud backups.</p></body></html>`,
    );
    win.document.close();
    win.focus();
    win.print();
  }

  function downloadWords() {
    const lines = words.map((word, i) => `${i + 1}. ${word}`).join("\n");
    const text =
      `Luna recovery phrase\n\n${lines}\n\n` +
      `Keep these ${words.length} words somewhere safe. Anyone with them can open your cloud backups.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "luna-recovery-phrase.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function save(event) {
    event.preventDefault();
    if (working) return;
    setError("");
    const wrong = positions.findIndex((pos, i) => answers[i] !== words[pos]);
    if (wrong !== -1) {
      setError(`Word ${positions[wrong] + 1} doesn't match. Check what you wrote down.`);
      shakeElement(formRef.current);
      boxes.current[wrong]?.focus();
      return;
    }
    setSaving(true);
    try {
      await onSave(entropy);
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, SAVE_FAILED));
      shakeElement(formRef.current);
    } finally {
      setSaving(false);
    }
  }

  const lead =
    intro === undefined ? (
      <p className="text-primary text-sm">
        Your recovery phrase locks your{" "}
        <TermHint surface={surface} content="Copies of your files kept online with Luna Connect. You can turn this on later.">
          cloud backups
        </TermHint>{" "}
        so only you can open them.
      </p>
    ) : (
      intro
    );

  if (step === "show") {
    return (
      <div className="space-y-4">
        {titles.show && <Heading className="font-mono font-normal text-xl text-primary">{titles.show}</Heading>}
        {lead}
        <p className="text-primary text-sm">
          {`Write these ${words.length} words on paper, in order. If you lose them, no one can open your cloud backups for you, including us.`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            aria-label="Number of words"
            surface={surface}
            value={String(words.length)}
            options={LENGTH_OPTIONS}
            onChange={chooseLength}
          />
          <p className="text-primary text-sm">
            {words.length === 24
              ? "24 words take longer to write down but add extra protection for backups you keep for years."
              : "12 words are enough for most people."}
          </p>
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {words.map((word, i) => (
            <li key={i} className="flex items-center gap-2 rounded-pill surface-primary px-3 py-2 text-sm">
              <span className="w-5 text-right text-xs font-mono">{i + 1}.</span>
              <InlinePill>{word}</InlinePill>
            </li>
          ))}
        </ol>
        {error && <InlineError>{error}</InlineError>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" surface={surface} size="sm" onClick={printWords}>
            Print
          </Button>
          <Button variant="outline" surface={surface} size="sm" onClick={downloadWords}>
            Download
          </Button>
          <Button variant="outline" surface={surface} size="sm" onClick={copyWords}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="primary" surface={surface} size="sm" onClick={() => goTo("confirm")}>
            I wrote it down
          </Button>
        </div>
        <p className="text-primary text-xs">Leaving this page before you finish makes a new phrase.</p>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={save} noValidate className="space-y-4">
      {titles.confirm && <Heading className="font-mono font-normal text-xl text-primary">{titles.confirm}</Heading>}
      <p className="text-primary text-sm">{`Type ${positionsSentence(positions)} from what you wrote down.`}</p>
      <ol className="grid grid-cols-1 gap-2">
        {positions.map((pos, i) => (
          <WordBox
            key={pos}
            position={pos + 1}
            value={answers[i]}
            onChange={(word) => {
              setError("");
              setAnswers((prev) => prev.map((v, j) => (j === i ? word : v)));
            }}
            onPasteWords={(list) => {
              setAnswers((prev) => prev.map((v, j) => (j === i ? list[0] : v)));
            }}
            onAdvance={() => boxes.current[i + 1]?.focus()}
            onPrev={i > 0 ? () => boxes.current[i - 1]?.focus() : undefined}
            onNext={i < 2 ? () => boxes.current[i + 1]?.focus() : undefined}
            enterSubmits={i === 2}
            enterKeyHint={i === 2 ? "done" : "next"}
            inputRef={(el) => {
              boxes.current[i] = el;
            }}
          />
        ))}
      </ol>
      {shownError && <InlineError>{shownError}</InlineError>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" surface={surface} size="sm" disabled={working} onClick={() => goTo("show")}>
          Back to the phrase
        </Button>
        <Button type="submit" variant="primary" surface={surface} size="sm" loading={working} disabled={working}>
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}

PhraseWriteDown.propTypes = {
  surface: PropTypes.oneOf(["primary", "secondary"]),
  onSave: PropTypes.func.isRequired,
  saveLabel: PropTypes.string,
  headingLevel: PropTypes.oneOf([2, 3]),
  titles: PropTypes.shape({ show: PropTypes.string, confirm: PropTypes.string }),
  intro: PropTypes.node,
  busy: PropTypes.bool,
  error: PropTypes.string,
  onStepChange: PropTypes.func,
};
