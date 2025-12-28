import { Link } from "react-router-dom";
import Card from "../components/common/cards/Card";

export default function NotFoundPage() {
  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32" aria-labelledby="not-found-title">
      <Card>
        <h1 id="not-found-title" className="text-4xl font-bold text-primary text-center mb-4">
          404
        </h1>
        <p className="text-accent text-center mb-6">Page not found</p>
        <Link
          to="/"
          className="inline-block bg-primary text-secondary rounded-pill p-3 motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid"
        >
          Go Home
        </Link>
      </Card>
    </main>
  );
}
