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
          </p>
        </HeaderCard>
      </header>

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
          </div>
        </Card>
      </section>
    </main>
  );
}
