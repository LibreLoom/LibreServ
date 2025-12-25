import { Link } from "react-router-dom";
import Card from "../components/common/cards/Card";
import { services } from "../data/services";

export default function AppsPage() {
  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32">
      <Card>
        <h1 className="text-2xl font-bold text-left mb-6">Apps</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((service) => (
            <Link
              key={service.name}
              to={`/apps/${service.name.toLowerCase()}`}
              className="bg-primary text-secondary rounded-pill p-4 motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid"
            >
              <div className="flex items-center gap-3">
                <service.icon size={24} />
                <span className="font-medium">{service.name}</span>
              </div>
            </Link>
          ))}
        </div>
      </Card>
    </main>
  );
}
