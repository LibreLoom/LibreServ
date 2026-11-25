import { useState } from "react";

/**
 * @typedef {{ deviceUid: string, verificationCode: string }} Guide
 */

const DEFAULT_GUIDES = [
  { deviceUid: "7K4M-2Q9X-R8N3-6T5W-1PZH", verificationCode: "A3F91C" },
  { deviceUid: "9C2D-7F4H-3J8K-5M6N-1PQR", verificationCode: "B7E42D" },
];

const panelH2 = "mb-[0.12in] font-mono text-[16pt] leading-none";
const panelH3 = "mb-[0.04in] font-mono text-[10pt] leading-[1.08]";
const chip = "eyebrow mb-[0.06in] inline-block border-[0.75pt] px-[0.07in] pt-[0.065in] pb-[0.06in] leading-none [text-box-trim:trim-both] [text-box-edge:cap_alphabetic]";
const footnote = "border-t-[0.75pt] border-accent pt-[0.07in]";
const fieldBox = "block border-[0.75pt] border-ink px-[0.06in] py-[0.055in] text-center font-mono text-[9pt] tracking-[0.025em]";

/** @param {string} value */
function formatDeviceUid(value) {
  const raw = value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 20);
  return raw.match(/.{1,4}/g)?.join("-") ?? "";
}

/** @param {string} value */
function formatVerificationCode(value) {
  return value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 6);
}

/** @param {Guide} guide */
function isComplete(guide) {
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(guide.deviceUid.replace(/-/g, ""))
    && /^[0-9A-F]{6}$/.test(guide.verificationCode);
}

function LogoMark() {
  return (
    <svg className="mb-[0.16in] size-[0.72in] fill-ink" viewBox="30 30 180 180" aria-hidden="true">
      <path d="M88.00 44.74 L88.00 99.70 A48 48 0 0 0 136.00 147.70 L197.11 147.70 A3.0 3.0 0 0 1 199.90 151.81 A86.0 86.0 1 1 1 83.73 42.02 A3.0 3.0 0 0 1 88.00 44.74Z" />
      <circle cx="136" cy="99.7" r="30" />
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
        <p className={`${chip} border-ink bg-ink text-paper`}>Option 1: Recommended</p>
        <h3 className={panelH3}>Set up with Luna Connect</h3>
        <p className="mb-[0.08in]">Remote access from anywhere, with optional cloud backup.</p>
        <p className="bg-ink px-[0.06in] py-[0.04in] text-center font-mono text-[7.5pt] text-paper">Start on the panel beside this one →</p>
      </div>
      <p className="mt-[0.12in] flex items-center gap-[0.08in] font-mono text-[9pt] leading-none before:flex-1 before:border-t-[0.75pt] before:border-accent before:content-[''] after:flex-1 after:border-t-[0.75pt] after:border-accent after:content-['']">
        or
      </p>
      <div className="mt-[0.12in] border-[0.75pt] border-accent px-[0.1in] py-[0.09in]">
        <p className={`${chip} border-accent`}>Option 2: Local only</p>
        <h3 className={panelH3}>Set up on your local network</h3>
        <p className="mb-[0.08in]">Everything stays on your home network.</p>
        <p className="border-[0.75pt] border-accent px-[0.06in] py-[0.04in] text-center font-mono text-[7.5pt]">Lift the flap on the right →</p>
      </div>
      <p className="mt-auto">Need help? Troubleshooting is under the flap on the right.</p>
    </section>
  );
}

/**
 * @param {{ deviceUid: string, verificationCode: string }} props
 */
function ConnectPanel({ deviceUid, verificationCode }) {
  return (
    <section className="panel panel-c">
      <p className="eyebrow mb-[0.04in]">Recommended</p>
      <h2 className={panelH2}>Set up with Luna Connect</h2>
      <p className="mb-[0.11in]">Go to <strong className="font-semibold">connect.luna.libreloom.org/onboarding</strong> and follow the steps.</p>
      <p className="mb-[0.035in]">Your Device ID</p>
      <span className={fieldBox}>{deviceUid}</span>
      <p className="mb-[0.1in] mt-[0.035in] text-[7pt]">This identifies your Luna.</p>
      <p className="mb-[0.035in]">Your Verification code</p>
      <span className={`${fieldBox} mx-auto w-[1.35in]`}>{verificationCode}</span>
      <p className="mt-[0.035in] text-center text-[7pt]">Do not share this code.</p>
      <p className={`${footnote} mt-[0.18in]`}>Your Luna Connect and Luna accounts are separate.</p>
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
        <li>Wait a few minutes for Luna to start. On a phone or computer on the same network, open <strong className="font-semibold">luna.local</strong> in a web browser.</li>
        <li>If that doesn't work, connect a screen to a video port on the back of Luna. On your phone or computer, open the address shown on the screen.</li>
        <li>Create the first Admin account. An Admin manages people, settings, drives, and all files except other people&apos;s private files and folders.</li>
        <li>Name Luna, finish setup, then plug in a USB drive. Nothing on the drive changes until you add it in Luna.</li>
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
        <h3 className={panelH3}>Pairing not working</h3>
        <ul className="grid list-disc gap-[0.03in] pl-[0.17in]">
          <li>Device ID has 20 characters in five groups of four; dashes do not matter.</li>
          <li>Verification code has six characters: 0-9 and A-F.</li>
          <li>Make sure Luna is on and waiting to pair, then try again.</li>
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

/** @param {Guide} props */
function ReverseGuide({ deviceUid, verificationCode }) {
  return (
    <div className="guide guide-reverse">
      <ConnectPanel deviceUid={deviceUid} verificationCode={verificationCode} />
      <ReservedPanel />
      <CoverPanel />
    </div>
  );
}

/**
 * @param {{ side: "front" | "reverse", guides: Guide[] }} props
 */
function PrintSheet({ side, guides }) {
  const isFront = side === "front";

  return (
    <section className="sheet" aria-label={`${side} print sheet`}>
      {guides.map((guide, index) => (
        <div className="guide-row" key={`${side}-${index}`}>
          {isFront ? <FrontGuide /> : <ReverseGuide {...guide} />}
        </div>
      ))}
      <div className="cut-line" aria-hidden="true" />
    </section>
  );
}

function App() {
  const [guides, setGuides] = useState(DEFAULT_GUIDES);
  const canPrint = guides.every(isComplete);

  /**
   * @param {number} index
   * @param {"deviceUid" | "verificationCode"} field
   * @param {string} value
   */
  const updateGuide = (index, field, value) => {
    setGuides((current) => current.map((guide, guideIndex) => {
      if (guideIndex !== index) return guide;
      return field === "deviceUid"
        ? { ...guide, deviceUid: formatDeviceUid(value) }
        : { ...guide, verificationCode: formatVerificationCode(value) };
    }));
  };

  return (
    <>
      <header className="sticky top-0 z-10 grid grid-cols-[minmax(18rem,1fr)_auto_auto] items-end gap-6 bg-ink px-5 py-4 text-paper max-[1300px]:static max-[1300px]:grid-cols-1 max-[1300px]:items-start print:hidden">
        <div>
          <p className="eyebrow">Luna packaging</p>
          <h1 className="my-[0.2rem] font-mono text-[1.45rem]">Quick-start print layout</h1>
          <p className="max-w-[44rem] text-[0.86rem] text-screen">Letter landscape, two guides per sheet, print at 100%, double-sided, flip on the short edge.</p>
        </div>
        <div className="flex gap-3 max-[1300px]:flex-wrap">
          {guides.map((guide, index) => (
            <div key={`guide-${index}`} className="grid grid-cols-2 gap-2 font-mono text-[0.72rem]">
              <p className="col-span-2">Guide {index + 1}</p>
              <label className="grid gap-1">
                Device ID
                <input
                  value={guide.deviceUid}
                  onChange={(event) => updateGuide(index, "deviceUid", event.target.value)}
                  spellCheck="false"
                  autoComplete="off"
                  maxLength={24}
                  placeholder="7K4M-2Q9X-R8N3-6T5W-1PZH"
                  className="w-[15rem] border border-accent bg-paper px-[0.65rem] py-[0.55rem] font-mono text-ink outline-none focus:border-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper"
                />
              </label>
              <label className="grid gap-1">
                Verification code
                <input
                  value={guide.verificationCode}
                  onChange={(event) => updateGuide(index, "verificationCode", event.target.value)}
                  spellCheck="false"
                  autoComplete="off"
                  maxLength={6}
                  placeholder="A3F91C"
                  className="w-[8rem] border border-accent bg-paper px-[0.65rem] py-[0.55rem] font-mono text-ink outline-none focus:border-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper"
                />
              </label>
            </div>
          ))}
        </div>
        <div className="grid justify-items-end gap-2 max-[1300px]:justify-items-start">
          {!canPrint && <p className="text-[0.72rem]">Enter both fields for each guide.</p>}
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!canPrint}
            className="cursor-pointer border border-paper bg-paper px-4 py-[0.65rem] font-mono text-ink hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper disabled:cursor-not-allowed"
          >
            Print two guides
          </button>
        </div>
      </header>

      <main className="grid justify-center gap-8 overflow-auto p-8 print:block print:overflow-visible print:p-0">
        <PrintSheet side="front" guides={guides} />
        <PrintSheet side="reverse" guides={guides} />
      </main>
    </>
  );
}

export default App;
