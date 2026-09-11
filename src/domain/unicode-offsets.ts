/**
 * The persisted provenance contract uses Unicode code-point offsets.
 *
 * JavaScript string indexes are UTF-16 code-unit indexes, so String#slice is
 * deliberately not used for persisted Evidence ranges.  Keep all conversion
 * and validation in this module so that server code, browser adapters, and
 * database-contract tests share one vocabulary.
 */

export type CodePointRange = Readonly<{
  start: number;
  end: number;
}>;

export type UnicodeOffsetErrorCode =
  | "invalid_offset"
  | "offset_out_of_bounds"
  | "invalid_range"
  | "utf16_surrogate_boundary";

export class UnicodeOffsetError extends Error {
  constructor(
    public readonly code: UnicodeOffsetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UnicodeOffsetError";
  }
}

/** Normalize extractor/browser line endings without changing any other text. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Return the number of Unicode code points, not UTF-16 code units. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new UnicodeOffsetError("invalid_offset", `${name} must be an integer`);
  }
}

/** Validate one inclusive-start code-point offset. */
export function validateCodePointOffset(text: string, offset: number, name = "offset"): void {
  assertInteger(offset, name);
  const length = codePointLength(text);
  if (offset < 0 || offset > length) {
    throw new UnicodeOffsetError(
      "offset_out_of_bounds",
      `${name} must be between 0 and ${length} code points`,
    );
  }
}

/** Validate a zero-based, half-open code-point range. */
export function validateCodePointRange(
  text: string,
  start: number,
  end: number,
  options: { allowEmpty?: boolean } = {},
): CodePointRange {
  validateCodePointOffset(text, start, "start");
  validateCodePointOffset(text, end, "end");
  if (end < start) {
    throw new UnicodeOffsetError("invalid_range", "end must be greater than or equal to start");
  }
  if (options.allowEmpty === false && end === start) {
    throw new UnicodeOffsetError("invalid_range", "range must contain at least one code point");
  }
  return { start, end };
}

/** Extract a code-point range without treating UTF-16 code units as offsets. */
export function codePointSlice(text: string, start: number, end: number): string {
  validateCodePointRange(text, start, end);
  return Array.from(text).slice(start, end).join("");
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function assertUtf16Offset(text: string, offset: number, name: string): void {
  assertInteger(offset, name);
  if (offset < 0 || offset > text.length) {
    throw new UnicodeOffsetError(
      "offset_out_of_bounds",
      `${name} must be between 0 and ${text.length} UTF-16 code units`,
    );
  }
  // A browser selection cannot safely identify half of an astral character.
  // Rejecting this case prevents silently persisting a range that is not a
  // code-point boundary.
  if (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  ) {
    throw new UnicodeOffsetError(
      "utf16_surrogate_boundary",
      `${name} falls inside an astral Unicode code point`,
    );
  }
}

/**
 * Convert DOM/browser UTF-16 selection offsets to persisted code-point
 * offsets. Both input offsets are UTF-16 code-unit indexes as supplied by a
 * browser Range or textarea selection.
 */
export function utf16SelectionToCodePointOffsets(
  text: string,
  startUtf16: number,
  endUtf16: number,
): CodePointRange {
  assertUtf16Offset(text, startUtf16, "startUtf16");
  assertUtf16Offset(text, endUtf16, "endUtf16");
  if (endUtf16 < startUtf16) {
    throw new UnicodeOffsetError("invalid_range", "endUtf16 must be greater than or equal to startUtf16");
  }

  // The prefix contains only complete code points because boundaries above
  // reject indexes in the middle of surrogate pairs.
  const start = Array.from(text.slice(0, startUtf16)).length;
  const end = Array.from(text.slice(0, endUtf16)).length;
  return { start, end };
}

