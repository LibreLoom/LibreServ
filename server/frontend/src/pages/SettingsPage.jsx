import HeaderCard from "../components/common/cards/HeaderCard";

export default function SettingsPage() {
  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32 text-center"
      aria-labelledby="settings-title"
      id="main-content"
      tabIndex={-1}
    >
      {/* Placeholder page so navigation has a landing spot. */}
      <HeaderCard id="settings-title" title="Settings" />
      <p className="text-accent mt-2">Settings are coming soon.</p>
    </main>
  );
}
