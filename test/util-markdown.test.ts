import { describe, expect, it } from "vitest";
import {
  lenientParseFrontmatter,
  stripBlockHtmlComments,
  toStringList,
} from "../src/util/markdown.js";

describe("stripBlockHtmlComments", () => {
  it("strips whole-line comments", () => {
    expect(stripBlockHtmlComments("line1\n<!-- note -->\nline2")).toBe("line1\nline2");
    expect(stripBlockHtmlComments("  <!-- indented -->  \nkeep")).toBe("keep");
  });

  it("strips multi-line comments closed at end of a line", () => {
    const input = "before\n<!-- first\nsecond\nthird -->\nafter";
    expect(stripBlockHtmlComments(input)).toBe("before\nafter");
  });

  it("keeps inline comments inside a line", () => {
    const input = "text <!-- inline --> more";
    expect(stripBlockHtmlComments(input)).toBe(input);
    const opener = "<!-- inline --> trailing text";
    expect(stripBlockHtmlComments(opener)).toBe(opener);
  });

  it("keeps comments inside code fences (regression: fence-unaware strip)", () => {
    const input = ["use:", "```html", "<!-- keep me: example -->", "```", "done"].join("\n");
    expect(stripBlockHtmlComments(input)).toBe(input);
    const tilde = ["~~~", "<!-- kept -->", "~~~"].join("\n");
    expect(stripBlockHtmlComments(tilde)).toBe(tilde);
  });

  it("an unclosed <!-- never deletes real content (regression)", () => {
    const input = ["<!-- oops unclosed", "text line", "```", "code --> more code", "```", "end"].join("\n");
    // Nothing may be deleted: the only '-->' is mid-line inside a fence.
    expect(stripBlockHtmlComments(input)).toBe(input);
  });

  it("does not treat a mid-line --> as a block comment closer", () => {
    const input = ["<!-- open", "middle --> trailing", "end"].join("\n");
    expect(stripBlockHtmlComments(input)).toBe(input);
  });

  it("preserves CRLF content on kept lines", () => {
    const input = "a\r\n<!-- gone -->\r\nb\r\n";
    expect(stripBlockHtmlComments(input)).toBe("a\r\nb\r\n");
  });

  it("still strips comments after a fenced block closes", () => {
    const input = ["```", "code", "```", "<!-- strip me -->", "tail"].join("\n");
    expect(stripBlockHtmlComments(input)).toBe(["```", "code", "```", "tail"].join("\n"));
  });
});

describe("toStringList: top-level comma splitting", () => {
  it("splits a plain comma list", () => {
    expect(toStringList("Read, Edit, Bash")).toEqual(["Read", "Edit", "Bash"]);
  });

  it("keeps commas inside braces (regression: glob alternation)", () => {
    expect(toStringList("src/**/*.{ts,tsx}, test/**")).toEqual([
      "src/**/*.{ts,tsx}",
      "test/**",
    ]);
  });

  it("keeps commas inside parentheses (regression: permission-style entries)", () => {
    expect(toStringList("Bash(echo a,b), Read")).toEqual(["Bash(echo a,b)", "Read"]);
  });

  it("keeps commas inside brackets and nested groups", () => {
    expect(toStringList("[a,b], c")).toEqual(["[a,b]", "c"]);
    expect(toStringList("Bash(git commit -m {x,[y,z]}), Edit(src/**)")).toEqual([
      "Bash(git commit -m {x,[y,z]})",
      "Edit(src/**)",
    ]);
  });

  it("is robust to unbalanced closers", () => {
    expect(toStringList(") stray, next")).toEqual([") stray", "next"]);
  });

  it("keeps array and scalar coercion behavior", () => {
    expect(toStringList(["a", " b ", ""])).toEqual(["a", "b"]);
    expect(toStringList(42)).toEqual(["42"]);
    expect(toStringList(undefined)).toBeUndefined();
    expect(toStringList(null)).toBeUndefined();
  });
});

describe("lenientParseFrontmatter: bracketed prose scalars", () => {
  it("keeps a scalar that starts with a closed bracket tag (regression)", () => {
    const fm = lenientParseFrontmatter("description: [WIP] fix: things");
    expect(fm.description).toBe("[WIP] fix: things");
  });

  it("still drops genuinely unclosed flow collections", () => {
    expect(lenientParseFrontmatter("tools: [Read, Write")).toEqual({});
    expect(lenientParseFrontmatter("meta: {a: 1")).toEqual({});
  });
});
