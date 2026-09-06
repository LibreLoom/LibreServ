import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  Download,
  Loader2,
  Search,
  Terminal,
  X,
} from "lucide-react";
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import Toggle from "../common/Toggle";
import Button from "../ui/Button";

const DEFAULT_LINE_COUNT = 500;
const LOAD_MORE_INCREMENT = 500;

function normaliseLines(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap((entry) => String(entry).split(/\r?\n/));
  }
  return String(input).split(/\r?\n/);
}

export default function LogsViewer({
  app,
  onClose,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [lineLimit, setLineLimit] = useState(DEFAULT_LINE_COUNT);
  const [hasMoreToLoad, setHasMoreToLoad] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const eventSourceRef = useRef(null);
  const outputRef = useRef(null);
  const searchInputRef = useRef(null);
  const isLoadingMoreRef = useRef(false);

  const streamUrl = useMemo(() => {
    if (!app?.id) return "";
    return `/api/v1/apps/${app.id}/logs/stream?tail=${lineLimit}&follow=true`;
  }, [app?.id, lineLimit]);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const appendChunk = useCallback((chunk) => {
    const newLines = normaliseLines(chunk);
    if (newLines.length === 0) return;
    setLines((prev) => {
      const updated = [...prev, ...newLines];
      if (updated.length > lineLimit) {
        setHasMoreToLoad(true);
        return updated.slice(-lineLimit);
      }
      return updated;
    });
  }, [lineLimit]);

  const startStream = useCallback(() => {
    if (!streamUrl) return;
    closeStream();
    setStreamError("");
    setLines([]);
    setHasMoreToLoad(false);
    setIsStreaming(true);

    const es = new EventSource(streamUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.type === "stdout" || payload?.type === "stderr") {
          appendChunk(payload.content || "");
          return;
        }
        if (payload?.content) {
          appendChunk(payload.content);
          return;
        }
        if (payload?.error) {
          setStreamError(payload.error);
        }
      } catch {
        appendChunk(event.data);
      }
    };

    es.onerror = () => {
      setIsStreaming(false);
      setStreamError((prev) => prev || "Live log stream disconnected.");
      es.close();
      eventSourceRef.current = null;
    };
  }, [appendChunk, closeStream, streamUrl]);

  useEffect(() => {
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startStream();
  }, [startStream]);

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  useEffect(() => {
    if (!autoScroll || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, autoScroll]);

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleLoadMore = useCallback(() => {
    const newLimit = lineLimit + LOAD_MORE_INCREMENT;
    isLoadingMoreRef.current = true;
    setLineLimit(newLimit);
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lineLimit]);

  const filteredLines = useMemo(() => {
    if (!filter.trim()) return lines;
    const lower = filter.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(lower));
  }, [filter, lines]);

  const handleDownload = useCallback(() => {
    const text = filteredLines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${app?.name || "app"}-logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLines, app?.name]);

  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
    if (showSearch) {
      setFilter("");
    }
  }, [showSearch]);

  return (
    <ModalCard
      title={
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="sm:hidden">Logs</span>
          <span className="hidden sm:inline">Log Viewer &bull; {app?.name || "App"}</span>
          {isStreaming && (
            <>
              <span className="sm:hidden relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
              </span>
              <div className="hidden sm:inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent font-sans">
                <span className="relative flex h-2 w-2 mr-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
                </span>
                Live Stream
              </div>
            </>
          )}
        </div>
      }
      onClose={onClose}
      size="xl"
      mobileFullscreen
    >
      <div className="flex flex-col min-h-0 space-y-2 sm:space-y-4">
        {/* Mobile toolbar */}
        <div className="flex sm:hidden items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            surface="secondary"
            onClick={handleToggleSearch}
            className={showSearch || filter ? "text-accent" : ""}
            aria-label="Toggle search"
          >
            <Search size={18} aria-hidden="true" />
          </Button>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-primary/20 bg-secondary text-primary">
            <ArrowDownToLine size={14} className={cn("shrink-0 transition-colors", autoScroll ? "text-accent" : "text-accent")} aria-hidden="true" />
            <Toggle
              checked={autoScroll}
              onChange={setAutoScroll}
              aria-label="Auto Scroll"
              className="[&>div]:hidden"
            />
          </div>

          <Button
            variant="ghost"
            size="icon"
            surface="secondary"
            onClick={handleDownload}
            aria-label="Download logs"
          >
            <Download size={18} aria-hidden="true" />
          </Button>
        </div>

        {/* Mobile collapsible search */}
        {showSearch && (
          <div className="sm:hidden shrink-0 animate-fade-in-up">
            <div className="relative bg-secondary text-primary rounded-pill border border-primary/20 focus-within:border-accent transition-colors">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-accent" />
              <input
                ref={searchInputRef}
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter logs"
                className="w-full bg-transparent pl-10 pr-10 py-2 text-primary placeholder:text-primary/50 focus:outline-none focus-visible:outline-none font-sans text-sm no-focus-outline"
              />
              <button
                type="button"
                onClick={handleToggleSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-accent hover:text-primary transition-colors"
                aria-label="Close search"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Desktop toolbar */}
        <div className="hidden sm:flex items-center justify-between shrink-0 gap-3">
          <div className="relative flex-1 min-w-0 w-full bg-secondary text-primary rounded-pill border-2 border-primary/20 focus-within:border-accent transition-colors">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-accent" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter logs"
              className="w-full bg-transparent pl-11 pr-4 py-2 text-primary placeholder:text-primary/50 focus:outline-none focus-visible:outline-none font-sans text-sm no-focus-outline"
            />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-3 px-4 py-1.5 rounded-pill border-2 border-primary/20 bg-secondary text-primary transition-colors focus-within:border-accent">
              <Toggle
                label="Auto Scroll"
                checked={autoScroll}
                onChange={setAutoScroll}
                iconOn={ArrowDownToLine}
                iconOff={ArrowDownToLine}
                className="gap-2 [&>div]:pr-0 [&>div>div]:text-xs"
              />
            </div>

            <Button
              variant="outline"
              surface="secondary"
              onClick={handleDownload}
              tooltip="Download logs"
              className="border-accent hover:bg-accent/20 hover:text-primary"
            >
              <Download size={16} className="inline -mt-0.5" />
              Download
            </Button>
          </div>
        </div>

        <Card noPopIn padding={false} className="flex flex-col min-h-0 overflow-hidden border border-primary/15">
          <div
            ref={outputRef}
            className="overflow-auto px-2 sm:px-4 py-3 font-sans text-[11px] sm:text-xs leading-6 text-accent max-h-[50vh] sm:max-h-[60vh]"
          >
            {filteredLines.length === 0 && streamError ? (
              <div className="py-10 text-center text-accent">
                Failed to load logs.
              </div>
            ) : filteredLines.length === 0 ? (
              <div className="py-10 text-center text-accent">
                No logs found for this app yet.
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words m-0">
                {filteredLines.map((line, i) => (
                  <div key={i} className={line.toLowerCase().includes("error") ? "text-error" : ""}>
                    {line}
                  </div>
                ))}
              </pre>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0 border-t border-primary/15 bg-secondary/50 text-primary px-3 sm:px-4 py-2">
            <div className="flex items-center gap-2 text-xs font-sans text-accent">
              <Terminal size={14} />
              <span>Showing last {lines.length} lines</span>
            </div>

            <div className="flex items-center gap-2">
              {hasMoreToLoad && !filter && (
                <Button
                  variant="outline"
                  size="sm"
                  surface="secondary"
                  onClick={handleLoadMore}
                  className="flex-1 sm:flex-none"
                >
                  <ChevronDown size={14} />
                  Load {LOAD_MORE_INCREMENT} more
                </Button>
              )}

              {isStreaming && filteredLines.length === 0 && (
                <div className="flex items-center gap-2 text-xs font-sans text-accent">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Streaming...</span>
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>
    </ModalCard>
  );
}
