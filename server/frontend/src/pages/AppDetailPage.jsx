import { useParams } from "react-router-dom";
import Card from "../components/common/cards/Card";
import { services } from "../data/services";
import NotFoundPage from "./NotFoundPage";

export default function AppDetailPage() {
  const { appName } = useParams();

  const service = services.find(
    (s) => s.name.toLowerCase() === appName.toLowerCase(),
  );

  if (!service) {
    return <NotFoundPage />;
  }

  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
      <header className="px-8 mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-center text-2xl font-bold">{service.name}</h1>
            </div>
          </div>
        </Card>
      </header>
    </main>
  );
}
