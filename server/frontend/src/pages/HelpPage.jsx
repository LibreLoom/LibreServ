import HeaderCard from "../components/common/cards/HeaderCard";

export default function HelpPage() {
  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32 text-center"
      aria-labelledby="help-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard id="help-title" title="Help" />
      <p className="text-accent mt-2">Help content is coming soon.</p>
    </main>
  );
}
