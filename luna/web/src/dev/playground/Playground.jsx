// Dev-only playground for the file operation card. It drives the REAL store
// and the REAL dock against a fake lunad, so every state of the card can be
// reached by clicking instead of by uploading a real 4 GB file.
//
// Nothing here ships: main.jsx loads it only on /__playground in dev.

import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { FileOpsProvider, useFileOps, useFileOpsState } from "../../context/FileOpsContext.jsx";
import { createFileOpsStore } from "../../lib/fileOps/store.js";
import FileOpsDock from "../../components/files/fileOps/FileOpsDock.jsx";
import {
  JOB_MODES,
  UPLOAD_MODES,
  badEntry,
  createFakeWorld,
  dirEntry,
  fakeFile,
  fileEntry,
  sleep,
} from "./fakeSource.js";

const SPEEDS = [
  { value: "fast", label: "Fast" },
  { value: "normal", label: "Normal" },
  { value: "slow", label: "Slow" },
];

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const DEST = { destFolder: "Documents", destLabel: "Documents" };

/** A row of buttons that wraps on a narrow window. */
function Actions({ children }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/** One heading and its buttons, inside a card. */
function Group({ label, children }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-xs">{label}</p>
      <Actions>{children}</Actions>
    </div>
  );
}

/**
 * The raw store state, so a wrong word on the card can be traced to the state
 * that produced it instead of guessed at.
 */
function StateReadout() {
  const ops = useFileOpsState((state) => state.ops);
  if (!ops.length) return <p className="text-sm">Nothing in the store.</p>;
  return (
    <ul className="space-y-3">
      {ops.map((op) => (
        <li key={op.id} className="space-y-1">
          <p className="font-mono text-xs">
            {op.kind} · {op.state}
            {op.policy ? ` · ${op.policy} for the rest` : ""}
            {op.shown ? "" : " · hidden"}
          </p>
          <ul className="space-y-0.5 pl-2">
            {op.items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 font-mono">{item.state}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The page behind the card, so the card is seen against a real surface. */
function AppBehind() {
  return (
    <div data-slot="playground-app" className="min-h-full surface-primary p-6">
      <h2 className="mb-1 font-mono text-lg">Files</h2>
      <p className="mb-6 text-sm">Documents on this Luna</p>
      <div className="max-w-xl space-y-2">
        {["Documents", "Family photos", "Holiday", "notes.txt", "readme.md"].map((name) => (
          <div
            key={name}
            className="flex items-center gap-3 rounded-large-element surface-secondary px-4 py-3"
          >
            <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
            <span className="shrink-0 font-mono text-xs">—</span>
          </div>
        ))}
      </div>
      <div className="mt-16 flex justify-center">
        <div className="flex gap-6 rounded-pill border-2 border-accent px-8 py-3">
          {["Home", "Photos", "Files", "Shared", "Settings"].map((label) => (
            <span key={label} className="font-mono text-xs">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Every way to start an operation on the card.
 * @param {{ world: ReturnType<typeof createFakeWorld> }} props
 */
function Controls({ world }) {
  const store = useFileOps();
  const { addToast } = useToast();

  const clearCard = () => {
    for (const op of store.getState().ops) store.dismiss(op.id);
    addToast({ type: "success", message: "Cleared the card." });
  };

  const uploadFiles = (files) =>
    store.startUpload({ source: world.source, driveId: "d1", ...DEST, files });

  const uploadDrop = (entries) =>
    store.startUpload({
      source: world.source,
      driveId: "d1",
      ...DEST,
      dropped: { entries, files: [] },
    });

  const startJobs = (kind, items) =>
    store.startJobs({
      kind,
      fromDrive: "d1",
      items,
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });

  const startRequest = (kind, names, { fails = false, ms = 700 } = {}) =>
    store.startRequest({
      kind,
      title: names.length === 1 ? names[0] : "",
      destLabel: "Documents",
      source: world.source,
      driveId: "d1",
      items: names.map((name) => ({
        name,
        run: async () => {
          await sleep(ms);
          // No words of its own: the card has to fall back to naming the action.
          if (fails) throw new Error("");
        },
      })),
    });

  const seed = (name, kind) => {
    world.seed("Documents", name, kind);
    addToast({ type: "success", message: `Put ${name} in Documents.` });
  };

  /** Twelve files, six of whose names are already taken: one inline, five behind "more". */
  const manyClashes = () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      fakeFile(`photo-${i + 1}.jpg`, 1_200_000 + i * 900_000),
    );
    for (const file of files.slice(0, 6)) world.seed("Documents", file.name, "file");
    uploadFiles(files);
  };

  /** Twelve files where one fails: the operation ends "partial", not "done". */
  const partialUpload = () => {
    world.setBehaviour({ failName: "photo-7.jpg" });
    uploadFiles(
      Array.from({ length: 12 }, (_, i) => fakeFile(`photo-${i + 1}.jpg`, 900_000 + i * 400_000)),
    );
  };

  return (
    <div className="space-y-3">
      <Card title="Upload">
        <Group label="Files">
          <Button size="sm" onClick={() => uploadFiles([fakeFile("notes.txt", 240_000)])}>
            One file
          </Button>
          <Button
            size="sm"
            onClick={() =>
              uploadFiles(
                Array.from({ length: 12 }, (_, i) =>
                  fakeFile(`photo-${i + 1}.jpg`, 1_200_000 + i * 900_000),
                ),
              )
            }
          >
            12 files
          </Button>
          <Button size="sm" onClick={() => uploadFiles([fakeFile("holiday.mp4", 4_000_000_000)])}>
            A 4 GB video
          </Button>
        </Group>
        <Group label="Dropped folders">
          <Button
            size="sm"
            onClick={() =>
              uploadDrop([
                dirEntry("Holiday", [
                  fileEntry("beach.jpg", 3_100_000),
                  fileEntry("ticket.pdf", 210_000),
                  dirEntry("Empty", []),
                ]),
              ])
            }
          >
            A folder with files
          </Button>
          <Button size="sm" onClick={() => uploadDrop([dirEntry("Empty folder", [])])}>
            Only empty folders
          </Button>
        </Group>
        <Group label="The browser itself fails">
          <Button size="sm" onClick={() => uploadDrop([badEntry("locked.pdf")])}>
            A file it can’t read
          </Button>
        </Group>
      </Card>

      <Card title="Name already taken">
        <Group label="Put something there first">
          <Button size="sm" onClick={() => seed("notes.txt", "file")}>
            notes.txt (file)
          </Button>
          <Button size="sm" onClick={() => seed("Holiday", "dir")}>
            Holiday (folder)
          </Button>
        </Group>
        <Group label="Then upload the same name">
          <Button size="sm" onClick={() => uploadFiles([fakeFile("notes.txt", 240_000)])}>
            Upload notes.txt over the file
          </Button>
          <Button size="sm" onClick={() => uploadFiles([fakeFile("Holiday", 90_000)])}>
            Upload a file named Holiday
          </Button>
        </Group>
        <p className="text-sm">
          A file over a file offers Replace. A file over a folder can’t: Luna can’t replace a
          folder with a file, so it offers Keep both and Skip only.
        </p>
        <Group label="Many at once">
          <Button size="sm" onClick={manyClashes}>
            12 files, 6 already there
          </Button>
          <Button size="sm" onClick={partialUpload}>
            12 files, one fails
          </Button>
        </Group>
        <p className="text-sm">
          Six clashes keep one problem inline and put the rest behind “5 more problems”. One
          failure among twelve ends the operation “partial”, not “done”.
        </p>
      </Card>

      <Card title="Copy and move">
        <Group label="Copying to Backup drive">
          <Button
            size="sm"
            onClick={() => startJobs("copy", [{ path: "Documents/notes.txt", name: "notes.txt" }])}
          >
            Copy one file
          </Button>
          <Button
            size="sm"
            onClick={() =>
              startJobs(
                "copy",
                Array.from({ length: 6 }, (_, i) => ({
                  path: `Documents/report-${i + 1}.pdf`,
                  name: `report-${i + 1}.pdf`,
                })),
              )
            }
          >
            Copy 6 files
          </Button>
        </Group>
        <Group label="Moving">
          <Button
            size="sm"
            onClick={() => startJobs("move", [{ path: "Documents/notes.txt", name: "notes.txt" }])}
          >
            Move one file
          </Button>
          <Button
            size="sm"
            onClick={() =>
              startJobs(
                "move",
                ["a.jpg", "b.jpg", "c.jpg"].map((name) => ({ path: `Holiday/${name}`, name })),
              )
            }
          >
            Move 3 files
          </Button>
        </Group>
      </Card>

      <Card title="Other tasks">
        <Group label="Trash">
          <Button size="sm" onClick={() => startRequest("trash", ["a.jpg"])}>
            Move 1 item to Trash
          </Button>
          <Button size="sm" onClick={() => startRequest("trash", ["a.jpg", "b.jpg"])}>
            Move 2 items to Trash
          </Button>
          <Button size="sm" onClick={() => startRequest("trash", ["a.jpg", "b.jpg", "c.jpg", "d.jpg"])}>
            Move 4 items (counted)
          </Button>
          <Button size="sm" onClick={() => startRequest("restore-trash", ["a.jpg", "b.jpg"])}>
            Put back 2 items
          </Button>
          <Button size="sm" onClick={() => startRequest("purge", ["old.zip"])}>
            Delete permanently
          </Button>
        </Group>
        <p className="text-sm">
          One to three items are named; four or more are counted. The meta line says how far
          along the batch is.
        </p>
        <Group label="A task that fails">
          <Button size="sm" onClick={() => startRequest("trash", ["a.jpg"], { fails: true })}>
            Move to Trash, then fail
          </Button>
        </Group>
        <Group label="A task that is stopped">
          <Button
            size="sm"
            onClick={() => {
              startRequest("trash", ["a.jpg", "b.jpg", "c.jpg"], { ms: 3000 });
              // Stop it a moment later, so the card has something to stop.
              setTimeout(() => {
                const op = store.getState().ops[0];
                if (op) store.cancel(op.id);
              }, 600);
            }}
          >
            Start, then cancel
          </Button>
        </Group>
        <Group label="One long task">
          <Button
            size="sm"
            onClick={() =>
              store.startRequest({
                kind: "empty-trash",
                title: "Backup drive",
                destLabel: "Backup drive",
                source: world.source,
                driveId: "d2",
                run: () => sleep(4000),
              })
            }
          >
            Empty Trash
          </Button>
          <Button
            size="sm"
            onClick={() =>
              store.startRequest({
                kind: "restore-backup",
                title: "notes.txt",
                destLabel: "Documents",
                source: world.source,
                driveId: "d1",
                run: () => sleep(2200),
              })
            }
          >
            Restore from a backup
          </Button>
          <Button
            size="sm"
            onClick={() =>
              store.startRequest({
                kind: "zip",
                title: "Family photos",
                destLabel: "Documents",
                source: world.source,
                driveId: "d1",
                run: () => sleep(2600),
              })
            }
          >
            Get a zip ready
          </Button>
        </Group>
      </Card>

      <Card title="Every transition, one at a time">
        <p className="text-sm">
          Each button fires the one change it names, so a transition can be watched on its own
          instead of hunted for inside a real upload.
        </p>
        <Group label="The card">
          <Button size="sm" onClick={() => uploadFiles([fakeFile("notes.txt", 240_000)])}>
            Card pops in
          </Button>
          <Button size="sm" onClick={clearCard}>
            Card pops out
          </Button>
        </Group>
        <Group label="A row">
          <Button size="sm" onClick={() => uploadFiles([fakeFile("a.txt", 120_000)])}>
            Row arrives
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const op = store.getState().ops.find((o) => o.shown);
              if (op) store.dismiss(op.id);
            }}
          >
            Row leaves
          </Button>
        </Group>
        <Group label="A line inside a row">
          <Button
            size="sm"
            onClick={() => {
              const op = store.getState().ops[0];
              if (op) store.retry(op.id);
            }}
          >
            Failure → running
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const op = store.getState().ops[0];
              const item = op?.items.find((i) => i.state === "failed");
              if (op && item) store.cancel(op.id, item.id);
            }}
          >
            Failure leaves
          </Button>
        </Group>
        <Group label="A clash">
          <Button size="sm" onClick={() => seed("b.txt", "file")}>
            Seed b.txt
          </Button>
          <Button size="sm" onClick={() => uploadFiles([fakeFile("b.txt", 90_000)])}>
            Upload into it
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const op = store.getState().ops.find((o) => o.items.some((i) => i.state === "needs-decision"));
              const item = op?.items.find((i) => i.state === "needs-decision");
              if (op && item) store.decide(op.id, item.id, "keep_both");
            }}
          >
            Clash → running
          </Button>
        </Group>
        <Group label="The problems list">
          <Button size="sm" onClick={manyClashes}>
            Fill it with 6 clashes
          </Button>
        </Group>
      </Card>

      <Card title="Behind the card">
        <StateReadout />
      </Card>
    </div>
  );
}

/**
 * @param {{ world: ReturnType<typeof createFakeWorld> }} props
 */
function PlaygroundBody({ world }) {
  const store = useFileOps();
  const { addToast } = useToast();
  const [upload, setUpload] = useState("ok");
  const [jobs, setJobs] = useState("ok");
  const [speed, setSpeed] = useState("normal");
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    world.setBehaviour({ upload });
  }, [world, upload]);
  useEffect(() => {
    world.setBehaviour({ jobs });
  }, [world, jobs]);
  useEffect(() => {
    const scale = speed === "fast" ? 0.25 : speed === "slow" ? 3.75 : 1;
    world.setBehaviour({ uploadMs: 1600 * scale, jobMs: 4000 * scale });
  }, [world, speed]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const clearCard = () => {
    for (const op of store.getState().ops) store.dismiss(op.id);
    addToast({ type: "success", message: "Cleared the card." });
  };

  return (
    <div
      data-slot="playground"
      className="flex min-h-screen flex-col gap-4 surface-primary p-4 pb-64 xl:flex-row xl:pb-4"
    >
      <div className="flex w-full flex-col gap-3 xl:w-[420px] xl:shrink-0">
        <div>
          <h1 className="font-mono text-lg">File operation card</h1>
          <p className="text-sm">
            Dev only. Drives the real store and the real card. The card floats over the page, as
            it does in the app, so narrow the window to check a phone.
          </p>
        </div>

        <Card title="Knobs">
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="font-mono text-xs">Upload</p>
              <SegmentedControl
                aria-label="What the next upload does"
                value={upload}
                onChange={setUpload}
                options={UPLOAD_MODES}
              />
            </div>
            <div className="space-y-1">
              <p className="font-mono text-xs">Copy and move</p>
              <SegmentedControl
                aria-label="What the next copy or move does"
                value={jobs}
                onChange={setJobs}
                options={JOB_MODES}
              />
            </div>
            <div className="space-y-1">
              <p className="font-mono text-xs">Speed</p>
              <SegmentedControl aria-label="Speed" value={speed} onChange={setSpeed} options={SPEEDS} />
            </div>
            <div className="space-y-1">
              <p className="font-mono text-xs">Theme</p>
              <SegmentedControl aria-label="Theme" value={theme} onChange={setTheme} options={THEMES} />
            </div>
            <Button size="sm" variant="outline" onClick={clearCard}>
              Clear the card
            </Button>
          </div>
        </Card>

        <Controls world={world} />
      </div>

      <div className="min-h-[400px] min-w-0 grow overflow-hidden rounded-large-element border-2 border-accent">
        <AppBehind />
      </div>

      <FileOpsDock />
    </div>
  );
}

export default function Playground() {
  const { addToast } = useToast();
  const toastRef = useRef(addToast);
  toastRef.current = addToast;

  const [world] = useState(() => createFakeWorld());
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [store] = useState(() =>
    createFileOpsStore({
      queryClient: client,
      addToast: (toast) => toastRef.current(toast),
      haptic,
      api: world.api,
      storage: null,
      restoreJobs: false,
    }),
  );

  useEffect(
    () => () => {
      store.destroy();
      world.dispose();
    },
    [store, world],
  );

  return (
    <QueryClientProvider client={client}>
      <FileOpsProvider store={store}>
        <PlaygroundBody world={world} />
      </FileOpsProvider>
    </QueryClientProvider>
  );
}
