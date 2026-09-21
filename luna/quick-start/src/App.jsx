import { useState } from "react";

const DEFAULT_TOKENS = [
  "XXXX-XXXX-XXXX-XXXX-XXXX",
  "YYYY-YYYY-YYYY-YYYY-YYYY",
];

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 240 240" aria-hidden="true">
      <rect className="logo-border" width="240" height="240" rx="32" />
      <rect className="logo-face" x="8" y="8" width="224" height="224" rx="26" />
      <circle className="logo-dot" cx="196" cy="196" r="24" />
    </svg>
  );
}

function CoverPanel() {
  return (
    <section className="panel panel-a cover-panel">
      <div className="welcome-card">
        <div className="step-dots" aria-hidden="true">
          <span className="active-dot" />
          <span />
          <span />
          <span />
          <span />
        </div>
        <LogoMark />
        <h2>Welcome.</h2>
        <p>Let&apos;s get Luna set up for you.</p>
        <div className="open-cue">Open the flap <span aria-hidden="true">→</span></div>
      </div>
    </section>
  );
}

function IndexPanel() {
  return (
    <section className="panel panel-a index-panel">
      <p className="eyebrow">Luna quick start</p>
      <h2>Choose your setup</h2>
      <div className="choice recommended-choice">
        <p className="choice-label">Recommended</p>
        <h3>Set up with Luna Connect</h3>
        <p>Remote access from anywhere, with optional cloud backup.</p>
        <p className="direction">Start on the panel beside this one.</p>
      </div>
      <div className="choice">
        <p className="choice-label">Set up without Luna Connect</p>
        <h3>Set up on your local network</h3>
        <p>Open the Luna Connect panel to see local-only setup and troubleshooting.</p>
      </div>
    </section>
  );
}

/**
 * @param {{ token: string }} props
 */
function ConnectPanel({ token }) {
  return (
    <section className="panel panel-c connect-panel">
      <p className="eyebrow">Recommended</p>
      <h2>Set up with Luna Connect</h2>
      <ol className="steps">
        <li>Go to <strong>connect.luna.libreloom.org/onboarding</strong>.</li>
        <li>Create an account or sign in, then verify your email.</li>
        <li>
          Enter the full device token from the card in your Luna&apos;s box.
          <span className="token">{token}</span>
        </li>
        <li>Choose your Luna address and whether to add cloud backup.</li>
        <li>Plug Luna into power and your router or modem with the included RJ45 (ethernet) cable.</li>
        <li>Open the link Luna Connect gives you. Create the separate Luna Admin account, name Luna, then add a USB drive.</li>
      </ol>
      <p className="small-note">Your Luna Connect and Luna Admin passwords are separate.</p>
    </section>
  );
}

function LocalPanel() {
  return (
    <section className="panel panel-b local-panel">
      <p className="eyebrow">Set up without Luna Connect</p>
      <h2>Set up on your local network</h2>
      <ol className="steps">
        <li>Plug Luna into power.</li>
        <li>Connect Luna to your router or modem with the included RJ45 (ethernet) cable.</li>
        <li>On a phone or computer using the same network, open the address shown on Luna&apos;s screen. You can also try <strong>luna.local</strong>.</li>
        <li>Create the first Admin account. An Admin can manage people, settings, drives, and every file on Luna.</li>
        <li>Name Luna, finish setup, then plug in a USB drive. Luna shows what is on it before changing anything.</li>
      </ol>
      <p className="small-note">Remote access and cloud backup stay off unless you link Luna Connect later.</p>
    </section>
  );
}

function TroubleshootingPanel() {
  return (
    <section className="panel panel-c troubleshooting-panel">
      <p className="eyebrow">Help</p>
      <h2>Troubleshooting</h2>
      <div className="help-block">
        <h3>Can&apos;t open Luna?</h3>
        <ul>
          <li>Check that power and the ethernet cable are firmly connected.</li>
          <li>Use a phone or computer on the same network as Luna.</li>
          <li>Try <strong>luna.local</strong> or the address shown on Luna&apos;s screen.</li>
          <li>Restart Luna and your router or modem, then wait a few minutes.</li>
        </ul>
      </div>
      <div className="help-block">
        <h3>Token not accepted?</h3>
        <ul>
          <li>Enter all five groups printed on the card.</li>
          <li>Check every letter and number, including the dashes.</li>
          <li>Keep the device token private.</li>
        </ul>
      </div>
      <div className="support-box">
        <p className="choice-label">Still stuck?</p>
        <p>Support link and QR code will go here.</p>
      </div>
    </section>
  );
}

function ReservedPanel() {
  return (
    <section className="panel panel-b reserved-panel" aria-label="Reserved panel">
      <p>Reserved</p>
    </section>
  );
}

function FrontGuide() {
  return (
    <div className="guide guide-front">
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
    <section className={`sheet sheet-${side}`} aria-label={`${side} print sheet`}>
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
      <header className="toolbar">
        <div>
          <p className="eyebrow">Luna packaging</p>
          <h1>Quick-start print layout</h1>
          <p>Letter landscape, two guides per sheet, print at 100%, double-sided, flip on the short edge.</p>
        </div>
        <div className="token-fields">
          {tokens.map((token, index) => (
            <label key={`token-${index}`}>
              Guide {index + 1} device token
              <input
                value={token}
                onChange={(event) => updateToken(index, event.target.value)}
                spellCheck="false"
              />
            </label>
          ))}
        </div>
        <button type="button" onClick={() => window.print()}>Print two guides</button>
      </header>

      <main className="preview">
        <PrintSheet side="front" tokens={tokens} />
        <PrintSheet side="reverse" tokens={tokens} />
      </main>
    </>
  );
}

export default App;
