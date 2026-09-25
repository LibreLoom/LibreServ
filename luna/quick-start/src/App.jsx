import { useState } from "react";

const DEFAULT_TOKENS = [
  "XXXX-XXXX-XXXX-XXXX-XXXX",
  "YYYY-YYYY-YYYY-YYYY-YYYY",
];

const panelH2 = "mb-[0.12in] font-mono text-[16pt] leading-none";
const panelH3 = "mb-[0.04in] font-mono text-[10pt] leading-[1.08]";
const chip = "eyebrow mb-[0.06in] inline-block border-[0.75pt] px-[0.07in] pt-[0.065in] pb-[0.06in] leading-none [text-box-trim:trim-both] [text-box-edge:cap_alphabetic]";
const footnote = "border-t-[0.75pt] border-accent pt-[0.07in] text-accent";

function LogoMark() {
  return (
    <svg className="mb-[0.16in] size-[0.72in]" viewBox="0 0 240 240" aria-hidden="true">
      <rect className="fill-accent" width="240" height="240" rx="32" />
      <rect className="fill-ink" x="8" y="8" width="224" height="224" rx="26" />
      <circle className="fill-paper stroke-accent" cx="196" cy="196" r="24" strokeWidth="6" />
    </svg>
  );
}

function CoverPanel() {
  return (
    <section className="panel panel-a grid place-items-center bg-soft p-[0.24in]">
      <div className="flex h-full w-full flex-col items-center justify-center rounded-[0.2in] border-[0.75pt] border-accent bg-paper p-[0.18in] text-center">
        <div className="absolute top-[0.32in] flex gap-[0.045in]" aria-hidden="true">
          <span className="h-[0.055in] w-[0.17in] rounded-full bg-ink" />
          <span className="size-[0.055in] rounded-full bg-accent" />
          <span className="size-[0.055in] rounded-full bg-accent" />
          <span className="size-[0.055in] rounded-full bg-accent" />
          <span className="size-[0.055in] rounded-full bg-accent" />
        </div>
        <LogoMark />
        <h2 className="mb-[0.08in] font-mono text-[25pt] leading-none">Welcome.</h2>
        <p className="mb-[0.2in] text-[10.5pt]">Let&apos;s get Luna set up for you.</p>
        <div className="bg-ink px-[0.16in] py-[0.08in] font-mono text-[9pt] text-paper">
          Open the flap <span aria-hidden="true">→</span>
        </div>
      </div>
    </section>
  );
}

function IndexPanel() {
  return (
    <section className="panel panel-a flex flex-col">
      <p className="eyebrow mb-[0.04in]">Luna quick start</p>
      <h2 className={panelH2}>Choose your setup</h2>
      <div className="mt-[0.12in] border-[1.5pt] border-ink px-[0.1in] py-[0.09in]">
        <p className={`${chip} border-ink bg-ink text-paper`}>Option 1 — Recommended</p>
        <h3 className={panelH3}>Set up with Luna Connect</h3>
        <p className="mb-[0.08in]">Remote access from anywhere, with optional cloud backup.</p>
        <p className="bg-ink px-[0.06in] py-[0.04in] text-center font-mono text-[7.5pt] text-paper">Start on the panel beside this one →</p>
      </div>
      <p className="mt-[0.12in] flex items-center gap-[0.08in] font-mono text-[9pt] leading-none uppercase tracking-[0.12em] text-accent before:flex-1 before:border-t-[0.75pt] before:border-accent before:content-[''] after:flex-1 after:border-t-[0.75pt] after:border-accent after:content-['']">
        or
      </p>
      <div className="mt-[0.12in] border-[0.75pt] border-accent px-[0.1in] py-[0.09in]">
        <p className={`${chip} border-accent`}>Option 2 — Local only</p>
        <h3 className={panelH3}>Set up on your local network</h3>
        <p className="mb-[0.08in]">Everything stays on your home network.</p>
        <p className="border-[0.75pt] border-accent px-[0.06in] py-[0.04in] text-center font-mono text-[7.5pt]">Lift the flap on the right →</p>
      </div>
      <p className="mt-auto">Need help? Troubleshooting is under the flap on the right.</p>
    </section>
  );
}

/**
 * @param {{ token: string }} props
 */
function ConnectPanel({ token }) {
  return (
    <section className="panel panel-c">
      <p className="eyebrow mb-[0.04in]">Recommended</p>
      <h2 className={panelH2}>Set up with Luna Connect</h2>
      <p className="mb-[0.11in]">Head to <strong className="font-semibold">connect.luna.libreloom.org/onboarding</strong> and follow the steps shown.</p>
      <p className="mb-[0.06in]">Your device token is</p>
      <span className="mt-[0.05in] block border-[0.75pt] border-b-0 border-ink px-[0.06in] py-[0.055in] text-center font-mono text-[9pt] tracking-[0.025em]">{token}</span>
      <p className="bg-ink px-[0.06in] py-[0.035in] text-center text-[7pt] text-paper">Do not share this token.</p>
      <p className={`${footnote} mt-[0.2in]`}>Your Luna Connect and Luna accounts are separate.</p>
    </section>
  );
}

function LocalPanel() {
  return (
    <section className="panel panel-b">
      <p className="eyebrow mb-[0.04in]">Set up without Luna Connect</p>
      <h2 className={panelH2}>Set up on your local network</h2>
      <ol className="grid list-decimal gap-[0.055in] pl-[0.19in]">
        <li>Plug your Luna into power using the adapter in the box.</li>
        <li>Connect Luna to your router or modem with the included RJ45 (ethernet) cable.</li>
        <li>Wait a few minutes for Luna to start. On a phone or computer on the same network, open <strong className="font-semibold">luna.local</strong> in a web browser of your choice.</li>
        <li>If that doesn't work, connect a screen to a video port on the back of Luna. On your phone or computer, open the address shown on the screen.</li>
        <li>Create the first Admin account. An Admin can manage people, settings, drives, and every file on Luna.</li>
        <li>Name Luna, finish setup, then plug in a USB drive. Luna shows what is on it before changing anything.</li>
      </ol>
      <p className={`${footnote} mt-[0.16in]`}>Remote access and cloud backup stay off unless you link Luna Connect later.</p>
    </section>
  );
}

function TroubleshootingPanel() {
  return (
    <section className="panel panel-c">
      <p className="eyebrow mb-[0.04in]">Help</p>
      <h2 className={panelH2}>Troubleshooting</h2>
      <div className="mt-[0.09in] border-t-[0.75pt] border-accent pt-[0.07in]">
        <h3 className={panelH3}>Luna won&apos;t come online</h3>
        <ul className="grid list-disc gap-[0.03in] pl-[0.17in]">
          <li>If Luna does not seem to turn on, press the power button once.</li>
          <li>Check that the ethernet cable clicks into place at Luna and at your router or modem.</li>
          <li>Wait a few minutes after plugging in.</li>
          <li>Try a different port on your router or modem.</li>
          <li>Check that other devices on your network can open a website.</li>
        </ul>
      </div>
      <div className="mt-[0.09in] border-t-[0.75pt] border-accent pt-[0.07in]">
        <h3 className={panelH3}>Token not accepted</h3>
        <ul className="grid list-disc gap-[0.03in] pl-[0.17in]">
          <li>Enter all five groups of four. Dashes and capitals do not matter.</li>
          <li>Check look-alike characters: 5 and S, 8 and B, 2 and Z, 6 and G.</li>
          <li>Still refused? Contact support.</li>
        </ul>
      </div>
      <div className="mt-[0.1in] border-[0.75pt] border-ink p-[0.09in]">
        <p className="eyebrow mb-[0.04in]">Still stuck?</p>
        <p>Support link and QR code will go here.</p>
      </div>
    </section>
  );
}

function ReservedPanel() {
  return <section className="panel panel-b" aria-hidden="true" />;
}

function FrontGuide() {
  return (
    <div className="guide">
      <IndexPanel />
      <LocalPanel />
      <TroubleshootingPanel />
    </div>
  );
}

/**
 * @param {{ token: string }} props
 */
function ReverseGuide({ token }) {
  return (
    <div className="guide guide-reverse">
      <ConnectPanel token={token} />
      <ReservedPanel />
      <CoverPanel />
    </div>
  );
}

/**
 * @param {{ side: "front" | "reverse", tokens: string[] }} props
 */
function PrintSheet({ side, tokens }) {
  const isFront = side === "front";

  return (
    <section className="sheet" aria-label={`${side} print sheet`}>
      {tokens.map((token, index) => (
        <div className="guide-row" key={`${side}-${index}`}>
          {isFront ? <FrontGuide /> : <ReverseGuide token={token} />}
        </div>
      ))}
      <div className="cut-line" aria-hidden="true" />
    </section>
  );
}

function App() {
  const [tokens, setTokens] = useState(DEFAULT_TOKENS);

  /**
   * @param {number} index
   * @param {string} value
   */
  const updateToken = (index, value) => {
    setTokens((current) => current.map((token, tokenIndex) => (
      tokenIndex === index ? value.toUpperCase() : token
    )));
  };

  return (
    <>
      <header className="sticky top-0 z-10 grid grid-cols-[minmax(18rem,1fr)_auto_auto] items-end gap-6 bg-ink px-5 py-4 text-paper max-[1100px]:static max-[1100px]:grid-cols-1 max-[1100px]:items-start print:hidden">
        <div>
          <p className="eyebrow">Luna packaging</p>
          <h1 className="my-[0.2rem] font-mono text-[1.45rem]">Quick-start print layout</h1>
          <p className="max-w-[44rem] text-[0.86rem] text-screen">Letter landscape, two guides per sheet, print at 100%, double-sided, flip on the short edge.</p>
        </div>
        <div className="flex gap-3 max-[1100px]:flex-wrap">
          {tokens.map((token, index) => (
            <label key={`token-${index}`} className="grid gap-1 font-mono text-[0.72rem]">
              Guide {index + 1} device token
              <input
                value={token}
                onChange={(event) => updateToken(index, event.target.value)}
                spellCheck="false"
                className="w-[15rem] border border-accent bg-paper px-[0.65rem] py-[0.55rem] font-mono text-ink outline-none focus:border-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper"
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="cursor-pointer border border-paper bg-paper px-4 py-[0.65rem] font-mono text-ink hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper"
        >
          Print two guides
        </button>
      </header>

      <main className="grid justify-center gap-8 overflow-auto p-8 print:block print:overflow-visible print:p-0">
        <PrintSheet side="front" tokens={tokens} />
        <PrintSheet side="reverse" tokens={tokens} />
      </main>
    </>
  );
}

export default App;
