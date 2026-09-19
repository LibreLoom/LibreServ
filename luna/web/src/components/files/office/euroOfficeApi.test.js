import { afterEach, describe, expect, it, vi } from "vitest";
import {
  euroOfficeDocumentType,
  canSaveOfficeExt,
  bundleUrl,
  watchEuroOfficeChanges,
  requestEuroOfficeSaveLock,
  patchEuroOfficeReconnect,
  patchEuroOfficeSaveState,
  restoreEuroOfficeEditing,
  x2tConvert,
  ensureOfficeBundle,
  EuroOfficeUnavailableError,
} from "./euroOfficeApi.js";
import { apiFetch, putBinary } from "../../../lib/api.js";

vi.mock("../../../lib/api.js", () => ({
  apiFetch: vi.fn(),
  postForm: vi.fn(),
  postJson: vi.fn(),
  putBinary: vi.fn(),
}));

/** Worker stub that detaches every transferred buffer, like real postMessage. */
class MockWorker {
  static reply = { out: new Uint8Array([7, 7, 7]), media: {} };
  /** Set to a string → every conversion replies ok:false with it. The
      module-level worker singleton is reused across tests, so the flag
      (not the constructor) carries the failure. */
  static fail = null;
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg, transfer) {
    for (const buf of transfer ?? []) buf.transfer?.();
    queueMicrotask(() => {
      if (MockWorker.fail) {
        this.onmessage?.({ data: { id: msg.id, ok: false, error: MockWorker.fail } });
      } else {
        const { out, media } = MockWorker.reply;
        this.onmessage?.({ data: { id: msg.id, ok: true, out, media } });
      }
    });
  }
  terminate() {}
}

describe("bundleUrl", () => {
  it("escapes each path segment but keeps slashes", () => {
    expect(bundleUrl("k-1", "Editor.bin")).toBe("/api/v1/office/bundle/k-1/Editor.bin");
    expect(bundleUrl("k 2", "media/my image.png")).toBe(
      "/api/v1/office/bundle/k%202/media/my%20image.png",
    );
  });
});

describe("canSaveOfficeExt", () => {
  it("allows the x2t round-trip set only", () => {
    expect(canSaveOfficeExt("docx")).toBe(true);
    expect(canSaveOfficeExt(".xlsx")).toBe(true);
    expect(canSaveOfficeExt("PPTX")).toBe(true);
    expect(canSaveOfficeExt("odt")).toBe(true);
    expect(canSaveOfficeExt("rtf")).toBe(true);
    expect(canSaveOfficeExt("xlsb")).toBe(true);
    // View-only: macro formats would lose VBA on save; legacy xls/ppt and
    // flat ODF have no writer in this build.
    expect(canSaveOfficeExt("docm")).toBe(false);
    expect(canSaveOfficeExt("xls")).toBe(false);
    expect(canSaveOfficeExt("ppt")).toBe(false);
    expect(canSaveOfficeExt("fodt")).toBe(false);
    expect(canSaveOfficeExt("pdf")).toBe(false);
    expect(canSaveOfficeExt("")).toBe(false);
  });
});

describe("euroOfficeDocumentType", () => {
  it("maps the verified word/cell/slide formats only", () => {
    // word
    expect(euroOfficeDocumentType("docs/a.docx")).toBe("word");
    expect(euroOfficeDocumentType("a.docm")).toBe("word");
    expect(euroOfficeDocumentType("a.fodt")).toBe("word");
    expect(euroOfficeDocumentType("a.docxf")).toBe("word");
    expect(euroOfficeDocumentType("a.oform")).toBe("word");
    expect(euroOfficeDocumentType("a.rtf")).toBe("word");
    // cell
    expect(euroOfficeDocumentType("a.xlsx")).toBe("cell");
    expect(euroOfficeDocumentType("a.xlsb")).toBe("cell");
    expect(euroOfficeDocumentType("a.ots")).toBe("cell");
    expect(euroOfficeDocumentType("a.xls")).toBe("cell");
    expect(euroOfficeDocumentType("a.xlt")).toBe("cell");
    // slide
    expect(euroOfficeDocumentType("a.pptx")).toBe("slide");
    expect(euroOfficeDocumentType("a.otp")).toBe("slide");
    expect(euroOfficeDocumentType("a.ppt")).toBe("slide");
    expect(euroOfficeDocumentType("a.pps")).toBe("slide");
  });

  it("returns null for formats the bundled x2t can't read", () => {
    // Declared by api.js but not in this wasm build.
    for (const name of [
      "a.doc", "a.txt", "a.fb2", "a.epub", "a.mht", "a.csv", "a.tsv",
      "a.numbers", "a.key", "a.pages", "a.pdf", "a.djvu", "a.xps", "a.oxps",
      "a.vsdx", "a.vssm", "a.gdoc",
    ]) {
      expect(euroOfficeDocumentType(name), name).toBeNull();
    }
  });

  it("is case-insensitive and returns null for non-office formats", () => {
    expect(euroOfficeDocumentType("Brief.DOCX")).toBe("word");
    expect(euroOfficeDocumentType("Scan.PDF")).toBeNull();
    expect(euroOfficeDocumentType("photo.png")).toBeNull();
    expect(euroOfficeDocumentType("pack.zip")).toBeNull();
    expect(euroOfficeDocumentType("noext")).toBeNull();
    expect(euroOfficeDocumentType("")).toBeNull();
  });
});

describe("watchEuroOfficeChanges", () => {
  it("forwards foreign op frames only", () => {
    /** @type {((data: any) => void)[]} */
    const handlers = [];
    const socketio = { on: (_ev, cb) => handlers.push(cb), off: vi.fn() };
    const iframe = {
      contentWindow: {
        Asc: { editor: { CoAuthoringApi: { _CoAuthoringApi: { socketio } } } },
      },
    };
    const cb = vi.fn();
    const unsub = watchEuroOfficeChanges(/** @type {any} */ (iframe), cb);
    expect(handlers).toHaveLength(1);
    const emit = handlers[0];
    emit({ type: "saveChanges", changes: [] });
    emit({ type: "authChanges", changes: [] });
    emit({ type: "lunaSaved" });
    emit({ type: "cursor", messages: [] });
    emit({ type: "releaseLock", locks: [] });
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
  });
});

describe("requestEuroOfficeSaveLock", () => {
  const makeIframe = (co) => ({
    contentWindow: {
      Asc: { editor: { CoAuthoringApi: { _CoAuthoringApi: co } } },
    },
  });

  it("resolves true on grant, false on deny, and fails open without a socket", async () => {
    /** @type {((data: any) => void)[]} */
    let handlers = [];
    const socketio = { on: (_e, cb) => handlers.push(cb), off: vi.fn() };
    const co = {
      socketio,
      _send: (msg) => {
        expect(msg.type).toBe("lunaSaveLock");
        queueMicrotask(() =>
          handlers.forEach((h) => h({ type: "lunaSaveLock", saveLock: false })),
        );
      },
    };
    await expect(
      requestEuroOfficeSaveLock(/** @type {any} */ (makeIframe(co))),
    ).resolves.toBe(true);

    // Denied election (peer mid-save) → false, so doSave leaves the doc dirty.
    handlers = [];
    co._send = () =>
      handlers.forEach((h) => h({ type: "lunaSaveLock", saveLock: true }));
    await expect(
      requestEuroOfficeSaveLock(/** @type {any} */ (makeIframe(co))),
    ).resolves.toBe(false);

    // No socket at all — nothing to clash with, save anyway.
    await expect(
      requestEuroOfficeSaveLock(
        /** @type {any} */ (makeIframe({ socketio: null })),
        50,
      ),
    ).resolves.toBe(true);
  });
});

describe("patchEuroOfficeReconnect", () => {
  const makeCo = () => ({
    onDisconnect: vi.fn(),
    _initSocksJs: vi.fn(),
    socketio: { connected: false, disconnect: vi.fn() },
    get_state: () => 0,
    isCloseCoAuthoring: false,
  });
  const makeIframe = (co) => ({
    contentWindow: {
      Asc: { editor: { CoAuthoringApi: { _CoAuthoringApi: co } } },
    },
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds on uncoded drops and concedes after the retry budget", () => {
    vi.useFakeTimers();
    const co = makeCo();
    const original = co.onDisconnect;
    const iframe = /** @type {any} */ (makeIframe(co));
    patchEuroOfficeReconnect(iframe);

    // Uncoded transport drop → suppress teardown, start rebuild loop.
    co.onDisconnect();
    expect(original).not.toHaveBeenCalled();
    expect(co.__lunaRebuilding).toBe(true);

    // Failed rebuilds keep arriving as uncoded drops (connect_error with
    // error data routes here with no code) — they must NOT reset the retry
    // budget, or the concede path is unreachable and the editor loops
    // forever instead of remounting.
    for (let i = 0; i < 40 && !co.__lunaConceded; i++) {
      vi.advanceTimersByTime(2_500);
      co.onDisconnect(); // each failed _initSocksJs re-lands here
    }
    expect(co.__lunaConceded).toBe(true);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("reconnect_failed rebuilds instead of taking the coded-drop teardown", () => {
    vi.useFakeTimers();
    const co = makeCo();
    const original = co.onDisconnect;
    const iframe = /** @type {any} */ (makeIframe(co));
    patchEuroOfficeReconnect(iframe);

    // The manager event isn't in the sdk's refreshable-code set — the stock
    // path parks the editor in view mode for good. We rebuild instead.
    co.onDisconnect("reconnect_failed", 4020);
    expect(original).not.toHaveBeenCalled();
    expect(co.__lunaRebuilding).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(co._initSocksJs).toHaveBeenCalled();
  });

  it("passes coded server drops through to the original handler", () => {
    const co = makeCo();
    const original = co.onDisconnect;
    const iframe = /** @type {any} */ (makeIframe(co));
    patchEuroOfficeReconnect(iframe);
    co.onDisconnect("restore", 4010);
    expect(original).toHaveBeenCalledWith("restore", 4010);
    expect(co.__lunaRebuilding).toBeFalsy();
  });
});

describe("patchEuroOfficeSaveState", () => {
  const makeCo = () => ({
    _state: 2, // Authorized
    _locks: {},
    _lockBuffer: [],
    _lockCallbacks: {},
    _lockCallbacksErrorTimerId: {},
    _send: vi.fn(),
    askSaveChanges: function (callback) {
      // stock: _state = AskSaveChanges + isSaveLock frame
      this._state = 11;
      this._send({ type: "isSaveLock" });
      callback && queueMicrotask(() => callback({ saveLock: false }));
    },
    askLock: function (blocks, callback) {
      // stock: buffers while in a save state, else sends getLock
      if (this._state === 3 || this._state === 11) {
        this._lockBuffer.push({ blocks, callback });
      } else {
        this._send({ type: "getLock", block: blocks });
      }
    },
  });
  const makeIframe = (co) => ({
    contentWindow: {
      AscCommon: { ConnectionState: { Authorized: 2, SaveChanges: 3, AskSaveChanges: 11 } },
      Asc: { editor: { CoAuthoringApi: { _CoAuthoringApi: co } } },
    },
  });

  it("grants save elections locally without the isSaveLock round-trip", async () => {
    const co = makeCo();
    patchEuroOfficeSaveState(/** @type {any} */ (makeIframe(co)));
    const cb = vi.fn();
    co.askSaveChanges(cb);
    // No frame on the wire, no state change — the freeze window is gone.
    expect(co._send).not.toHaveBeenCalled();
    expect(co._state).toBe(2);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ saveLock: false }));
  });

  it("mirrors the stock error for non-Authorized save requests", async () => {
    const co = makeCo();
    co._state = 0; // disconnected-ish
    patchEuroOfficeSaveState(/** @type {any} */ (makeIframe(co)));
    const cb = vi.fn();
    co.askSaveChanges(cb);
    await vi.waitFor(
      () => expect(cb).toHaveBeenCalledWith({ error: "No connection" }),
      { timeout: 500 },
    );
  });

  it("sends getLock instead of buffering while a save flush is in flight", () => {
    const co = makeCo();
    co._state = 3; // SaveChanges — stock would buffer the lock
    patchEuroOfficeSaveState(/** @type {any} */ (makeIframe(co)));
    co.askLock([{ guid: "g1" }], vi.fn());
    expect(co._lockBuffer).toHaveLength(0);
    expect(co._send).toHaveBeenCalledWith({ type: "getLock", block: [{ guid: "g1" }] });
    // The save transaction's state must be restored afterwards.
    expect(co._state).toBe(3);
  });

  it("still buffers nothing in AskSaveChanges and leaves Authorized alone", () => {
    const co = makeCo();
    patchEuroOfficeSaveState(/** @type {any} */ (makeIframe(co)));
    co._state = 11;
    co.askLock([{ guid: "g2" }], vi.fn());
    expect(co._lockBuffer).toHaveLength(0);
    expect(co._send).toHaveBeenCalled();
    co._state = 2;
    co.askLock([{ guid: "g3" }], vi.fn());
    expect(co._send).toHaveBeenCalledTimes(2);
  });
});

describe("restoreEuroOfficeEditing", () => {
  /**
   * Minimal fake of the iframe world: sdk api + co api + Common utils + a
   * document stub. `overrides` merges onto the window so each test starts
   * from a sane "no wedge" baseline.
   */
  const makeIframe = (overrides = {}) => {
    const sink = { focus: vi.fn() };
    const doc = {
      activeElement: null,
      body: {},
      documentElement: {},
      hasFocus: () => true,
      getElementById: () => sink,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const w = {
      document: doc,
      Asc: {
        c_oAscAsyncActionType: { BlockInteraction: 1 },
        editor: {
          asc_enableKeyEvents: vi.fn(),
          WordControl: { IsFocus: true, TextBoxInput: sink },
          CoAuthoringApi: {
            _CoAuthoringApi: {
              _state: 2,
              _sendBufferedLocks: vi.fn(),
            },
          },
        },
      },
      AscCommon: {
        ConnectionState: { Authorized: 2, SaveChanges: 3, AskSaveChanges: 11 },
      },
      Common: {
        Utils: { ModalWindow: { isVisible: () => false } },
        util: { Shortcuts: { resumeEvents: vi.fn() } },
      },
      DE: {
        getController: () => ({
          stackLongActions: { get: () => undefined },
          loadMask: { isVisible: () => false, hide: vi.fn() },
        }),
      },
      ...overrides,
    };
    return { iframe: { contentWindow: w }, w, sink, doc };
  };

  it("unparks a stalled save state and re-arms key input", () => {
    const { iframe, w } = makeIframe();
    const co = w.Asc.editor.CoAuthoringApi._CoAuthoringApi;
    co._state = 3; // SaveChanges — wedged with buffered locks
    restoreEuroOfficeEditing(/** @type {any} */ (iframe));
    expect(co._state).toBe(2);
    expect(co._sendBufferedLocks).toHaveBeenCalled();
    expect(w.Asc.editor.asc_enableKeyEvents).toHaveBeenCalledWith(true);
  });

  it("refocuses the keyboard sink when the iframe owns DOM focus", () => {
    const { iframe, sink, doc } = makeIframe();
    doc.activeElement = doc.body; // sink lost focus; IsFocus stayed true
    restoreEuroOfficeEditing(/** @type {any} */ (iframe));
    expect(sink.focus).toHaveBeenCalled();
  });

  it("never steals focus when the iframe document isn't focused", () => {
    const { iframe, sink, doc } = makeIframe();
    doc.hasFocus = () => false;
    restoreEuroOfficeEditing(/** @type {any} */ (iframe));
    expect(sink.focus).not.toHaveBeenCalled();
  });

  it("leaves a real modal and a live block action alone", () => {
    const { iframe, w, sink } = makeIframe();
    w.Common.Utils.ModalWindow.isVisible = () => true;
    restoreEuroOfficeEditing(/** @type {any} */ (iframe));
    expect(w.Asc.editor.asc_enableKeyEvents).not.toHaveBeenCalled();
    expect(sink.focus).not.toHaveBeenCalled();

    const withBlock = makeIframe();
    withBlock.w.DE.getController = () => ({
      stackLongActions: { get: () => ({ id: 99 }) }, // BlockInteraction live
      loadMask: { isVisible: () => true, hide: vi.fn() },
    });
    restoreEuroOfficeEditing(/** @type {any} */ (withBlock.iframe));
    expect(withBlock.w.Common.util.Shortcuts.resumeEvents).not.toHaveBeenCalled();
  });

  it("drops a stale loadmask and resumes shortcuts", () => {
    const { iframe, w, doc } = makeIframe();
    const el = { remove: vi.fn() };
    doc.querySelector = () => el; // .asc-loadmask present
    doc.querySelectorAll = () => [el, el];
    restoreEuroOfficeEditing(/** @type {any} */ (iframe));
    expect(el.remove).toHaveBeenCalled();
    expect(w.Common.util.Shortcuts.resumeEvents).toHaveBeenCalled();
  });
});

describe("x2tConvert", () => {
  afterEach(() => {
    delete globalThis.Worker;
  });

  it("does not detach the caller's input buffer", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.reply = { out: new Uint8Array([7, 7, 7]), media: {} };
    const src = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await x2tConvert("in.docx", "Editor.bin", src);
    expect(res.out).toEqual(new Uint8Array([7, 7, 7]));
    // The worker receives a copy — the caller's buffer must survive for the
    // follow-up bundle PUT. Transferring the caller's buffer emptied it and
    // the Editor.bin PUT landed as 0 bytes, poisoning the whole bundle.
    expect(src.byteLength).toBe(5);
    expect([...src]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("ensureOfficeBundle", () => {
  const session = /** @type {any} */ ({ key: "k1", file_type: "rtf" });
  const headRes = (len) =>
    new Response(null, {
      status: 200,
      headers: { "Content-Length": String(len) },
    });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(putBinary).mockReset();
    MockWorker.fail = null;
    delete globalThis.Worker;
  });

  /**
   * apiFetch mock for the convert path: no stored Editor.bin (bundle HEAD
   * fails), content GET returns bytes, and /eurooffice/* HEAD probes answer
   * per `pack` — "present" (real JS), "missing" (SPA-HTML fallback), or
   * "unreachable" (fetch throws).
   */
  function mockConvertFetch(pack = "present") {
    vi.mocked(apiFetch).mockImplementation(async (url, opts) => {
      const u = String(url);
      if (opts?.method === "HEAD") {
        if (u.startsWith("/eurooffice/")) {
          if (pack === "unreachable") throw new Error("network down");
          return new Response(null, {
            status: 200,
            headers: {
              "Content-Type": pack === "present" ? "text/javascript" : "text/html",
            },
          });
        }
        return new Response(null, { status: 404 });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });
  }

  it("re-converts when the stored Editor.bin is empty (poisoned bundle)", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.reply = { out: new Uint8Array([9, 9, 9]), media: {} };
    vi.mocked(apiFetch).mockImplementation(async (_url, opts) =>
      opts?.method === "HEAD"
        ? headRes("0")
        : new Response(new Uint8Array([1, 2, 3, 4])),
    );
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).resolves.toEqual({ converted: true });
    // Every bundle PUT must carry a non-empty body — the detached-buffer
    // bug sent byteLength 0 for the input that was reused after conversion.
    const puts = vi.mocked(putBinary).mock.calls;
    expect(puts.length).toBeGreaterThanOrEqual(2);
    for (const [, body] of puts) expect(body.byteLength).toBeGreaterThan(0);
  });

  it("skips conversion when a real Editor.bin exists", async () => {
    vi.mocked(apiFetch).mockResolvedValue(headRes("1234"));
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).resolves.toEqual({ converted: false });
    expect(vi.mocked(putBinary)).not.toHaveBeenCalled();
  });

  it("fails rather than storing an empty Editor.bin", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.reply = { out: new Uint8Array(0), media: {} };
    vi.mocked(apiFetch).mockImplementation(async (_url, opts) =>
      opts?.method === "HEAD"
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([1, 2, 3])),
    );
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).rejects.toThrow("empty");
    expect(vi.mocked(putBinary)).not.toHaveBeenCalled();
  });

  it("keeps the damaged-file message when the pack is fully present", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.fail = "x2t exit 4";
    mockConvertFetch("present");
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).rejects.toThrow("couldn't convert this file");
    expect(vi.mocked(putBinary)).not.toHaveBeenCalled();
  });

  it("blames a missing converter — not the file — when pack assets are absent", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.fail = "worker failed";
    mockConvertFetch("missing");
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).rejects.toBeInstanceOf(EuroOfficeUnavailableError);
    expect(vi.mocked(putBinary)).not.toHaveBeenCalled();
  });

  it("reports unreachable separately from both pack and file faults", async () => {
    globalThis.Worker = /** @type {any} */ (MockWorker);
    MockWorker.fail = "x2t exit 4";
    mockConvertFetch("unreachable");
    await expect(
      ensureOfficeBundle("d1", "a/Letter.rtf", session),
    ).rejects.toThrow("Couldn't reach Luna");
  });
});
