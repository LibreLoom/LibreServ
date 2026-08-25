import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import Card from "../cards/Card";
import EmptyState from "../common/EmptyState";
import { getDrives, getJson } from "../../lib/api";

function folderOf(path) {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function resultHref(item) {
  const folder = folderOf(item.path);
  if (!folder) return `/drives/${item.drive_id}`;
  return `/drives/${item.drive_id}?path=${encodeURIComponent(folder)}`;
}

/**
 * File search across drives this person can open. Results are already
 * filtered to folders they are allowed to see.
 */
export default function FileSearch({ compact = false }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const labels = Object.fromEntries((drives.data || []).map((d) => [d.id, d.label]));

  const results = useQuery({
    queryKey: ["search", q],
    queryFn: () => getJson(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });

  return (
    <Card className={compact ? "mb-4" : "mb-6"} padding>
      <label className="block">
        <span className="sr-only">Find a file</span>
        <span className="flex items-center gap-3 rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 focus-within:ring-2 focus-within:ring-accent">
          <Search size={16} className="text-accent shrink-0" aria-hidden="true" />
          <input
            className="flex-1 min-w-0 bg-transparent text-secondary text-sm focus:outline-none"
            placeholder="Find a file by name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Find a file by name"
          />
        </span>
      </label>
      <p className="text-primary text-xs mt-2">
        Luna looks through the files you can open. Type at least two letters.
      </p>

      {q.length >= 2 && results.isError && (
        <p className="text-error text-xs mt-2">
          {String(results.error?.message || "Luna couldn't search right now. Try again.")}
        </p>
      )}

      {q.length >= 2 && !results.isLoading && (results.data || []).length === 0 && (
        <EmptyState
          className="mt-3"
          title="Nothing matched"
          description="Try another name, or open a drive and browse. Luna only shows files you're allowed to see."
        />
      )}

      {(results.data || []).length > 0 && (
        <ul className="mt-3 grid gap-2">
          {results.data.map((item) => (
            <li key={`${item.drive_id}:${item.path}`}>
              <Link
                to={resultHref(item)}
                className="flex items-center justify-between gap-3 rounded-large-element bg-primary text-secondary px-4 py-2 hover:ring-2 hover:ring-accent motion-safe:transition-colors"
              >
                <span className="font-mono text-sm truncate">{item.name}</span>
                <span className="text-xs text-secondary shrink-0 truncate max-w-[40%]">
                  {labels[item.drive_id] || "A drive"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
