import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import Card from "../components/common/cards/Card";

export default function LorePage() {
  const [loreContent, setLoreContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    import("../../../../.lore/lore.md?raw")
      .then((module) => {
        setLoreContent(module.default);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
      <header className="px-8 mb-10">
        <Card>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Lore</h1>
            <p className="text-lg text-accent font-semibold">
              You found the lore page!
            </p>
          </div>
        </Card>
      </header>

      {/* Content */}
      <section className="px-8">
        <Card>
          {loading && <p>Loading lore...</p>}
          {error && <p className="text-accent">Error: {error}</p>}
          {!loading && !error && (
            <div className="markdown-content">
              <ReactMarkdown
                components={{
                  h1: (props) => (
                    <h1 className="text-3xl font-bold mb-4 mt-6" {...props} />
                  ),
                  h2: (props) => (
                    <h2 className="text-2xl font-bold mb-3 mt-5" {...props} />
                  ),
                  h3: (props) => (
                    <h3 className="text-xl font-bold mb-2 mt-4" {...props} />
                  ),
                  h4: (props) => (
                    <h4 className="text-lg font-bold mb-2 mt-3" {...props} />
                  ),
                  h5: (props) => (
                    <h5 className="text-base font-bold mb-2 mt-3" {...props} />
                  ),
                  h6: (props) => (
                    <h6 className="text-sm font-bold mb-2 mt-2" {...props} />
                  ),
                  p: (props) => <p className="mb-4" {...props} />,
                  ul: (props) => (
                    <ul
                      className="list-disc list-inside mb-4 ml-4"
                      {...props}
                    />
                  ),
                  ol: (props) => (
                    <ol
                      className="list-decimal list-inside mb-4 ml-4"
                      {...props}
                    />
                  ),
                  li: (props) => <li className="mb-1" {...props} />,
                  code: ({ inline, ...props }) =>
                    inline ? (
                      <code
                        className="bg-secondary px-1 py-0.5 rounded text-sm"
                        {...props}
                      />
                    ) : (
                      <code
                        className="block bg-accent text-secondary p-4 rounded mb-4 overflow-x-auto"
                        {...props}
                      />
                    ),
                  hr: (props) => (
                    <hr className="my-6 border-accent" {...props} />
                  ),
                  a: (props) => (
                    <a
                      className="text-accent underline hover:no-underline"
                      {...props}
                    />
                  ),
                }}
              >
                {loreContent}
              </ReactMarkdown>
            </div>
          )}
        </Card>
      </section>
    </main>
  );
}
