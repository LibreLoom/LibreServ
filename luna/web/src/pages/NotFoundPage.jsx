import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import TextLink from "../components/ui/TextLink";

export default function NotFoundPage() {
  return (
    <Page title="Nothing here">
      <Card padding>
        <p className="text-primary text-sm mb-4">
          That page doesn&apos;t exist on Luna.
        </p>
        <TextLink surface="secondary" to="/">Back home</TextLink>
      </Card>
    </Page>
  );
}
