import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import WipeDriveDialog from "./WipeDriveDialog.jsx";
import {
  WIPE_WAIT_SECONDS,
  previewFromInspection,
  wipeContentsHeading,
  wipeContentsNote,
  wipeTargetCopy,
} from "../../lib/wipeCopy.js";

const EMPTY = {
  drive_id: "d1",
  label: "Spare stick",
  used_bytes: 96 * 1024,
  meaningful: false,
  target_fs: "ext4",
  target_encrypted: true,
  entries: [],
  folders: 0,
  files: 0,
  readable: true,
};

const FULL = {
  ...EMPTY,
  used_bytes: 4 * 1024 * 1024 * 1024,
  meaningful: true,
  entries: [
    { name: "Holiday 2019", kind: "folder" },
    { name: "taxes.pdf", kind: "file" },
  ],
  folders: 1,
  files: 1,
};

/** Fake timers so the 30-second wait does not slow the suite down. */
function withFakeTimers(fn) {
  return () => {
    vi.useFakeTimers();
    try {
      fn();
    } finally {
      vi.useRealTimers();
    }
  };
}

/** Advance the countdown by `seconds`, letting React flush in between. */
function tick(seconds) {
  for (let i = 0; i < seconds; i += 1) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wipeContentsHeading", () => {
  it("counts what is on the drive", () => {
    expect(wipeContentsHeading(EMPTY)).toBe("This drive is empty");
    expect(wipeContentsHeading(FULL)).toBe("This drive has 2 items on it");
    expect(wipeContentsHeading({ ...FULL, folders: 1, files: 0 })).toBe(
      "This drive has 1 item on it",
    );
  });

  it("says so when Luna could not look inside", () => {
    expect(wipeContentsHeading({ ...FULL, readable: false })).toBe(
      "Luna can't see inside this drive",
    );
  });
});

describe("wipeContentsNote", () => {
  it("says an empty drive has nothing to lose", () => {
    expect(wipeContentsNote(EMPTY)).toBe("There is nothing here to lose.");
  });

  it("says the deletion cannot be undone when there are files", () => {
    expect(wipeContentsNote(FULL)).toContain("can't be undone");
  });

  it("warns that an unreadable drive may hold anything", () => {
    expect(wipeContentsNote({ ...FULL, readable: false })).toContain(
      "Anything on it will be lost",
    );
  });
});

describe("previewFromInspection", () => {
  const INSPECTED = {
    device: "sdb",
    model: "Lexar USB Flash Drive",
    readable: true,
    entries: [{ name: "Holiday", kind: "folder" }],
    folders: 1,
    files: 1,
    used_bytes: 4 * 1024 * 1024 * 1024,
    meaningful: true,
  };

  it("carries the daemon's verdict across rather than deciding again", () => {
    // The rule lives in the daemon. If the UI re-derived "is this empty?" from
    // a file count the two could disagree, and one of the wipes would skip the
    // wait. The mapped preview repeats what `inspect` decided.
    const preview = previewFromInspection(INSPECTED, "Lexar");
    expect(preview.meaningful).toBe(true);
    expect(preview.used_bytes).toBe(4 * 1024 * 1024 * 1024);
    expect(
      previewFromInspection({ ...INSPECTED, meaningful: false }, "Lexar").meaningful,
    ).toBe(false);
  });

  it("describes a drive that has just been added as plain and readable anywhere", () => {
    const preview = previewFromInspection(INSPECTED, "Lexar");
    expect(preview.target_fs).toBe("exfat");
    expect(preview.target_encrypted).toBe(false);
    expect(wipeTargetCopy(preview)).toContain("any computer");
  });

  it("uses the device name, because a drive that was never added has no id", () => {
    expect(previewFromInspection(INSPECTED, "Lexar").drive_id).toBe("sdb");
  });

  it("passes the label through so the dialog names the drive being wiped", () => {
    expect(previewFromInspection(INSPECTED, "Holiday photos").label).toBe(
      "Holiday photos",
    );
  });

  it("says nothing at all before the inspection answers", () => {
    expect(previewFromInspection(undefined, "Lexar")).toBeUndefined();
  });
});

describe("wipeTargetCopy", () => {
  it("says an encrypted result can only be read by a Luna", () => {
    expect(wipeTargetCopy({ ...EMPTY, target_encrypted: true })).toContain(
      "only a Luna can read it",
    );
  });

  it("says a plain exFAT result is readable anywhere", () => {
    expect(
      wipeTargetCopy({ ...EMPTY, target_encrypted: false, target_fs: "exfat" }),
    ).toContain("any computer");
  });
});

describe("WipeDriveDialog", () => {
  it("lets an empty drive be wiped immediately, with one confirmation", () => {
    const onConfirm = vi.fn();
    render(
      <WipeDriveDialog
        preview={EMPTY}
        title="Wipe this drive?"
        confirmLabel="Wipe"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const button = screen.getByRole("button", { name: "Wipe" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // No countdown text for a drive with nothing on it.
    expect(screen.queryByText(/You can wipe this drive in/)).not.toBeInTheDocument();
  });

  it(
    "makes you wait before wiping a drive that holds something",
    withFakeTimers(() => {
      const onConfirm = vi.fn();
      render(
        <WipeDriveDialog
          preview={FULL}
          title="Wipe this drive?"
          confirmLabel="Wipe"
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      // The button is disabled and counts down, so a mis-click cannot land.
      const button = screen.getByRole("button", { name: `Wait ${WIPE_WAIT_SECONDS}s` });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(onConfirm).not.toHaveBeenCalled();

      tick(WIPE_WAIT_SECONDS - 1);
      expect(screen.getByRole("button", { name: "Wait 1s" })).toBeDisabled();

      tick(1);
      const ready = screen.getByRole("button", { name: "Wipe" });
      expect(ready).toBeEnabled();
      fireEvent.click(ready);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    }),
  );

  it("lists what is about to be lost", () => {
    render(
      <WipeDriveDialog
        preview={FULL}
        title="Wipe this drive?"
        confirmLabel="Wipe"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("Holiday 2019")).toBeInTheDocument();
    expect(screen.getByText("taxes.pdf")).toBeInTheDocument();
    expect(screen.getByText(/Everything on it will be deleted/)).toBeInTheDocument();
  });

  it("summarises the rest when there are more names than fit", () => {
    const many = {
      ...FULL,
      entries: Array.from({ length: 12 }, (_, i) => ({
        name: `file-${i}`,
        kind: "file",
      })),
      folders: 0,
      files: 40,
    };
    render(
      <WipeDriveDialog
        preview={many}
        title="Wipe this drive?"
        confirmLabel="Wipe"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("and 28 more")).toBeInTheDocument();
  });

  it("warns that an encrypted drive cannot be recovered without its password", () => {
    render(
      <WipeDriveDialog
        preview={EMPTY}
        title="Wipe this drive?"
        confirmLabel="Wipe"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(
      screen.getByText(/Nobody can recover this drive without it/),
    ).toBeInTheDocument();
  });

  it("shows a progress bar while the drive is being checked", () => {
    render(
      <WipeDriveDialog
        preview={undefined}
        loading
        title="Wipe this drive?"
        confirmLabel="Wipe"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    // Nothing to confirm until the preview arrives.
    expect(screen.getByRole("button", { name: "Wipe" })).toBeDisabled();
  });

  it("keeps the dialog open and shows the reason when the wipe fails", () => {
    render(
      <WipeDriveDialog
        preview={EMPTY}
        title="Wipe this drive?"
        confirmLabel="Wipe"
        error="Something is still using this drive."
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("Something is still using this drive.")).toBeInTheDocument();
  });

  it(
    "starts a fresh wait for a different drive",
    withFakeTimers(() => {
      // The caller keys the dialog on the drive, so a second drive mounts a
      // new dialog and cannot inherit a countdown that already ran.
      const { rerender } = render(
        <WipeDriveDialog
          key="d1"
          preview={FULL}
          title="Wipe this drive?"
          confirmLabel="Wipe"
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );
      tick(WIPE_WAIT_SECONDS);
      expect(screen.getByRole("button", { name: "Wipe" })).toBeEnabled();

      rerender(
        <WipeDriveDialog
          key="d2"
          preview={{ ...FULL, drive_id: "d2" }}
          title="Wipe this drive?"
          confirmLabel="Wipe"
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );
      expect(
        screen.getByRole("button", { name: `Wait ${WIPE_WAIT_SECONDS}s` }),
      ).toBeDisabled();
    }),
  );
});
