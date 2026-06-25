<<<<<<< HEAD
import { ArrowLeft } from "lucide-react";
import Card from "../components/cards/Card";
import CardButton from "../components/cards/CardButton";
import HeaderCard from "../components/cards/HeaderCard";
import pigeonImg from "../assets/pigeon.jpg";

export default function PigeonPage() {
  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      id="main-content"
      tabIndex={-1}
    >
      {/* Header */}
      <header className="mb-10">
        <HeaderCard title="A Wild Pigeon Appears">
          <p className="text-lg text-secondary/80 font-semibold">
            You followed the clipboard. The pigeon was waiting.
=======
import { Link } from "react-router-dom";
import Card from "../components/cards/Card";
import HeaderCard from "../components/cards/HeaderCard";

// Easter-egg destination. The lore page's "THE END" clipboard links here.
// Reached via /pigeon — a small reward for curious readers.
export default function PigeonPage() {
  return (
    <main
      className="bg-primary text-secondary px-0 pt-5 pb-32"
      id="main-content"
      tabIndex={-1}
    >
      <header className="px-8 mb-10">
        <HeaderCard title="🐦 Pigeon">
          <p className="text-lg text-secondary/80 font-semibold">
            You followed the clipboard. The pigeon thanks you.
>>>>>>> f0826bdf (fix(frontend): add missing PigeonPage for /pigeon route)
          </p>
        </HeaderCard>
      </header>

<<<<<<< HEAD
      {/* Content */}
      <section aria-label="Pigeon">
        <Card>
          <img
            src={pigeonImg}
            alt=""
            className="mx-auto block h-auto max-w-full rounded-large-element"
          />

          <div className="mt-6 flex justify-center">
            <CardButton
              action="/lore"
              actionLabel="Back to Lore"
              icon={ArrowLeft}
              className="max-w-xs"
            />
=======
      <section className="px-8" aria-label="Pigeon">
        <Card>
          <pre className="text-secondary/80 text-sm leading-tight whitespace-pre overflow-x-auto" aria-hidden="true">
            {`        .-.
       /(o)\\\\
       \\\\ , /
        \`-''
       /  |
      /   |
     /    |
    /_____|
   =========`}
          </pre>
          <p className="mt-6 text-secondary/80">
            The pigeon has no lore of its own. It only carries the lore of
            others — clutched in a clipboard, flown from page to page, never
            reading a word. You read it. That was the whole point.
          </p>
          <p className="mt-4 text-secondary/60 text-sm">
            Nothing left to find here. Best head back.
          </p>
          <div className="mt-8">
            <Link
              to="/lore"
              className="inline-block bg-accent text-secondary px-5 py-2 rounded-full text-sm font-semibold transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
            >
              ← Back to the lore
            </Link>
>>>>>>> f0826bdf (fix(frontend): add missing PigeonPage for /pigeon route)
          </div>
        </Card>
      </section>
    </main>
  );
<<<<<<< HEAD
}
=======
}
>>>>>>> f0826bdf (fix(frontend): add missing PigeonPage for /pigeon route)
