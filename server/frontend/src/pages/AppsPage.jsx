import Card from "../components/common/cards/Card";
import ServiceCards from "../components/common/cards/ServiceCards";

export default function AppsPage() {
  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32">
      <Card>
        <h1 className="text-2xl font-bold text-left">Apps</h1>
      </Card>
      <div className="mt-5 flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start">
        {ServiceCards()}
      </div>
    </main>
  );
}
