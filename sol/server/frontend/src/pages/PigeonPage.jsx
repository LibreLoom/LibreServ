import { ArrowLeft } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import pigeonImg from "../assets/pigeon.jpg";

export default function PigeonPage() {
  return (
    <Page
      title="A Wild Pigeon Appears"
      headerClassName="mb-10"
      bottomContent={
        <p className="text-lg font-semibold">
          You followed the clipboard. The pigeon was waiting.
        </p>
      }
    >
      {/* Content */}
      <section aria-label="Pigeon" data-slot="pigeon">
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
    </Page>
  );
}
