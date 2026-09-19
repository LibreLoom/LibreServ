import { describe, expect, it } from "vitest";
import { parseDelimited, sniffDelimiter } from "./delimited.js";

describe("parseDelimited", () => {
  it("splits plain rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields, escaped quotes, and embedded commas", () => {
    expect(parseDelimited('"say ""hi""",b,c\n1,2,3')).toEqual([
      ['say "hi"', "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseDelimited('a,"line one\nline two"\nx,y')).toEqual([
      ["a", "line one\nline two"],
      ["x", "y"],
    ]);
  });

  it("handles CRLF and a trailing newline without a phantom row", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseDelimited("﻿a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("respects an explicit delimiter and doesn't sniff tabs as structure", () => {
    expect(parseDelimited("a\tb\tc\n1\t2\t3", "\t")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("sniffs semicolon-delimited csv", () => {
    expect(parseDelimited("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("sniffs tabs for unlabeled tsv data", () => {
    expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
  });

  it("defaults to comma when no candidate is consistent", () => {
    // Commas inside quoted fields must not confuse the sniff.
    expect(sniffDelimiter('"a,b",c\n"1,2",3')).toBe(",");
    expect(parseDelimited('"a,b",c\n"1,2",3')).toEqual([
      ["a,b", "c"],
      ["1,2", "3"],
    ]);
  });

  it("keeps empty cells", () => {
    expect(parseDelimited("a,,c\n,2,")).toEqual([
      ["a", "", "c"],
      ["", "2", ""],
    ]);
  });
});
