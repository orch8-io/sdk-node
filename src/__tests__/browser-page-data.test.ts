// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_BYTES,
  OutputTooLargeError,
  assertOutputSize,
  jsonByteLength,
  querySelectorAllText,
  querySelectorText,
  readForm,
  readSelection,
} from "../browser/index.js";

beforeEach(() => {
  document.body.innerHTML = `
    <form id="order">
      <input name="email" value="ada@example.com">
      <input name="password" type="password" value="hunter2">
      <input name="csrf" type="hidden" value="csrf-token">
      <input name="avatar" type="file">
      <input name="tags" type="checkbox" value="a" checked>
      <input name="tags" type="checkbox" value="b">
      <input name="tags" type="checkbox" value="c" checked>
      <input name="size" type="radio" value="s">
      <input name="size" type="radio" value="m" checked>
      <select name="colors" multiple><option value="red" selected>R</option><option value="blue" selected>B</option></select>
      <textarea name="note">  hello  </textarea>
      <input name="off" value="x" disabled>
      <button name="go" value="1">Go</button>
    </form>
    <h1 class="title">  Order #42 </h1>
    <li class="item">one</li><li class="item"> two </li>`;
});

describe("page-data helpers", () => {
  it("readForm returns JSON values and never reads passwords, files or (by default) hidden fields", () => {
    expect(readForm("#order")).toEqual({
      email: "ada@example.com",
      tags: ["a", "c"],
      size: "m",
      colors: ["red", "blue"],
      note: "  hello  ",
    });
    const withHidden = readForm(document.querySelector<HTMLFormElement>("#order")!, { includeHidden: true });
    expect(withHidden.csrf).toBe("csrf-token");
    expect(withHidden).not.toHaveProperty("password");
  });

  it("readForm reports a missing form", () => {
    expect(() => readForm("#missing")).toThrow(/no form matches #missing/);
  });

  it("querySelectorText and querySelectorAllText trim text content", () => {
    expect(querySelectorText(".title")).toBe("Order #42");
    expect(querySelectorText(".absent")).toBeNull();
    expect(querySelectorAllText(".item")).toEqual(["one", "two"]);
  });

  it("readSelection returns the selected text", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".title")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    expect(readSelection().trim()).toBe("Order #42");
  });

  it("assertOutputSize measures UTF-8 JSON bytes against the 1 MiB default", () => {
    expect(MAX_OUTPUT_BYTES).toBe(1_048_576);
    expect(jsonByteLength({ a: "é" })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(() => assertOutputSize({ s: "x".repeat(100) })).not.toThrow();
    expect(() => assertOutputSize("x".repeat(MAX_OUTPUT_BYTES))).toThrow(OutputTooLargeError);
    try {
      assertOutputSize({ s: "0123456789" }, 8);
    } catch (err) {
      expect(err).toBeInstanceOf(OutputTooLargeError);
      expect((err as OutputTooLargeError).retryable).toBe(false);
      expect((err as Error).message).toMatch(/exceeds the 8-byte limit/);
    }
  });
});
