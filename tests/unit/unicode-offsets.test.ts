import { describe, expect, it } from "vitest";
import {
  codePointLength,
  codePointSlice,
  normalizeLineEndings,
  UnicodeOffsetError,
  utf16SelectionToCodePointOffsets,
  validateCodePointRange,
} from "@/domain/unicode-offsets";

describe("Unicode code-point provenance offsets", () => {
  it("counts and slices ASCII using zero-based half-open offsets", () => {
    const text = "Evidence\nspan";
    expect(codePointLength(text)).toBe(13);
    expect(codePointSlice(text, 0, 8)).toBe("Evidence");
    expect(codePointSlice(text, 9, 13)).toBe("span");
    expect(validateCodePointRange(text, 0, 8, { allowEmpty: false })).toEqual({ start: 0, end: 8 });
  });

  it("treats an astral emoji as one code point while converting browser offsets", () => {
    const text = "A😀B";
    expect(text.length).toBe(4); // UTF-16 code units
    expect(codePointLength(text)).toBe(3);
    expect(codePointSlice(text, 1, 2)).toBe("😀");
    expect(utf16SelectionToCodePointOffsets(text, 1, 3)).toEqual({ start: 1, end: 2 });
  });

  it("handles CJK and combining sequences as code points, not grapheme clusters", () => {
    const text = "漢字e\u0301";
    expect(codePointLength(text)).toBe(4);
    expect(codePointSlice(text, 0, 2)).toBe("漢字");
    expect(codePointSlice(text, 2, 4)).toBe("e\u0301");
    expect(utf16SelectionToCodePointOffsets(text, 2, text.length)).toEqual({ start: 2, end: 4 });
  });

  it("handles mixed Unicode and normalizes CRLF/CR to LF", () => {
    const text = normalizeLineEndings("A😀\r\n漢字\rB\u0301");
    expect(text).toBe("A😀\n漢字\nB\u0301");
    expect(codePointLength(text)).toBe(8);
    expect(codePointSlice(text, 1, 3)).toBe("😀\n");
    expect(utf16SelectionToCodePointOffsets(text, 1, 3)).toEqual({ start: 1, end: 2 });
  });

  it("rejects one-sided, reversed, empty-when-disallowed, and out-of-bounds ranges", () => {
    expect(() => validateCodePointRange("abc", 0, 4)).toThrow(UnicodeOffsetError);
    expect(() => validateCodePointRange("abc", 2, 1)).toThrowError(/end must be greater/);
    expect(() => validateCodePointRange("abc", 1, 1, { allowEmpty: false })).toThrowError(/at least one/);
    expect(() => utf16SelectionToCodePointOffsets("A😀B", 2, 3)).toThrowError(/astral/);
  });
});

