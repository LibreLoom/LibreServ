import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollabSqliteClient } from "./sqliteCollab.js";

/** A stand-in database that remembers the statements run on it. */
function fakeInner() {
  const state = { statements: /** @type {string[]} */ ([]), opens: 0 };
  return {
    state,
    open: async () => {
      state.opens += 1;
      state.statements = [];
      return { tables: [] };
    },
    exec: async (/** @type {string} */ sql) => {
      if (/boom/.test(sql)) throw new Error("boom");
      if (/^\s*select/i.test(sql)) return { rows: [] };
      state.statements.push(sql);
      return { changes: 1 };
    },
    apply: async (/** @type {string} */ sql) => {
      state.statements.push(sql);
      return { changes: 1 };
    },
    schema: async () => ({ tables: [] }),
    exportBytes: async () => new Uint8Array([1, 2, 3]),
    close: async () => {},
    dispose: () => {},
  };
}

/** Two docs that exchange updates only when `flush` is called. */
function linkedDocs() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const queue = { a: /** @type {Uint8Array[]} */ ([]), b: /** @type {Uint8Array[]} */ ([]) };
  a.on("update", (u, origin) => origin !== "remote" && queue.b.push(u));
  b.on("update", (u, origin) => origin !== "remote" && queue.a.push(u));
  const flush = () => {
    for (const u of queue.b.splice(0)) Y.applyUpdate(b, u, "remote");
    for (const u of queue.a.splice(0)) Y.applyUpdate(a, u, "remote");
  };
  return { a, b, flush };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const FILE = new Uint8Array([9]);

async function pair() {
  const docs = linkedDocs();
  const left = fakeInner();
  const right = fakeInner();
  const a = new CollabSqliteClient(left, { ydoc: docs.a, revision: "1:1" });
  const b = new CollabSqliteClient(right, { ydoc: docs.b, revision: "1:1" });
  await a.open(FILE);
  await b.open(FILE);
  return { ...docs, left, right, a, b };
}

describe("CollabSqliteClient", () => {
  it("runs a change on the other copy once it is shared", async () => {
    const { a, flush, right } = await pair();
    await a.exec("INSERT INTO t VALUES (1)");
    flush();
    await settle();
    expect(right.state.statements).toEqual(["INSERT INTO t VALUES (1)"]);
  });

  it("does not share reads or changes that failed", async () => {
    const { a, flush, right } = await pair();
    await a.exec("SELECT * FROM t");
    await expect(a.exec("INSERT INTO boom VALUES (1)")).rejects.toThrow("boom");
    flush();
    await settle();
    expect(right.state.statements).toEqual([]);
  });

  it("rebuilds in the shared order when two changes cross", async () => {
    const { a, b, flush, left, right } = await pair();
    await a.exec("INSERT INTO t VALUES ('a')");
    await b.exec("INSERT INTO t VALUES ('b')");
    flush();
    await settle();
    await settle();
    expect(left.state.statements).toEqual(right.state.statements);
    expect(left.state.statements).toHaveLength(2);
  });

  it("refuses transactions while editing together", async () => {
    const { a } = await pair();
    await expect(a.exec("BEGIN")).rejects.toThrow(/Transactions/);
  });

  it("lets a later joiner skip what a save already covers", async () => {
    const { a, flush } = await pair();
    await a.exec("INSERT INTO t VALUES (1)");
    await a.exportBytes();
    a.markSaved("2:2");
    flush();
    const late = fakeInner();
    const joiner = new CollabSqliteClient(late, { ydoc: new Y.Doc(), revision: "2:2" });
    Y.applyUpdate(joiner.ydoc, Y.encodeStateAsUpdate(a.ydoc), "remote");
    await joiner.open(FILE);
    expect(late.state.statements).toEqual([]);
  });
});
