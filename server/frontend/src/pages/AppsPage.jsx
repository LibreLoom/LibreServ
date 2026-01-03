import HeaderCard from "../components/common/cards/HeaderCard";
import ServiceCards from "../components/common/cards/ServiceCards";

export default function AppsPage() {
  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="apps-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard id="apps-title" title="Apps" />
      {/* Reuse the service cards grid so list stays consistent with Dashboard. */}
      <div className="mt-5 flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start">
        {ServiceCards()}
      </div>
    </main>
  );
}
