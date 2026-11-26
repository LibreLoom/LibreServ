import { Search } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { openFileSearch } from "../../lib/fileSearch.js";

export default function FileSearchButton() {
  return (
    <span className="inline-flex" data-slot="file-search-trigger">
      <Button
        variant="ghost"
        surface="secondary"
        size="icon"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="/"
        onClick={openFileSearch}
      >
        <Search size={20} aria-hidden="true" />
      </Button>
    </span>
  );
}
