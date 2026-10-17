import { useState } from "react";
import { StepTransitionProvider } from "@libreloom/ui/components/setup/StepTransition.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { SetupShell, SetupCard, StepDots, WelcomeStep } from "./SetupPage.jsx";

// Dev-only (/dev/setup-loading): the real setup card and Welcome step with
// manual control over when loading ends, plus slow motion, so each phase of
// the loading → first step hand-off can be watched.
const SPEEDS = [
  { label: "1×", value: 1 },
  { label: "3× slower", value: 3 },
  { label: "6× slower", value: 6 },
];

export default function SetupLoadingDemoPage() {
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(3);
  const [run, setRun] = useState(0);

  const restart = () => {
    setLoading(true);
    setRun((n) => n + 1);
  };

  return (
    <StepTransitionProvider stepKey="welcome" direction="right">
      <SetupShell>
        <SetupCard
          key={`${run}-${slow}`}
          header={<StepDots current="welcome" />}
          loading={loading}
          slow={slow}
        >
          <WelcomeStep onBegin={() => {}} cascade={!loading} slow={slow} />
        </SetupCard>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button variant="secondary" onClick={() => setLoading(false)} disabled={!loading}>
            Finish loading
          </Button>
          <Button variant="outline" surface="primary" onClick={restart}>
            Restart
          </Button>
          {SPEEDS.map((o) => (
            <Button
              key={o.value}
              surface="primary"
              variant={slow === o.value ? "secondary" : "outline"}
              onClick={() => { setSlow(o.value); setLoading(true); }}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <p className="mt-4 text-sm text-secondary text-center max-w-md">
          The wave loops until you choose Finish loading. Then it fades out as the
          first step cascades in.
        </p>
      </SetupShell>
    </StepTransitionProvider>
  );
}
