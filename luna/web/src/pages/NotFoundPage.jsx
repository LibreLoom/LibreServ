import Page from "../components/ui/Page";
import TextLink from "../components/ui/TextLink";

export default function NotFoundPage() {
  return (
    <Page title="Nothing here">
      <p className="text-secondary mb-4">
        That page doesn&apos;t exist on Luna.
      </p>
      <TextLink to="/">Back home</TextLink>
    </Page>
  );
}
