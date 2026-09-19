import { parse as parseBibTeXDocument, type BibTeXEntry, type BibTeXParseResult } from "@retorquere/bibtex-parser";
import { normalizeDoiForComparison, normalizeTitleForComparison } from "./search-normalization";

export type ReferenceFormat = "bibtex" | "ris";
export type ReferenceFieldState = "missing" | "empty" | "present";
export type DiagnosticSeverity = "warning" | "error";

export interface ByteSpan {
  startByte: number;
  endByte: number;
}

export interface ReferenceDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  span?: ByteSpan;
}

export interface ReferenceAuthor {
  family: string | null;
  given: string | null;
  suffix: string | null;
  literal: string | null;
  raw: string;
}

export interface ReferenceField {
  name: string;
  state: ReferenceFieldState;
  value: string | null;
  rawValue: string | null;
  span?: ByteSpan;
}

export interface ImportedReference {
  format: ReferenceFormat;
  sourceSpan: ByteSpan;
  raw: string;
  key: string | null;
  entryType: string | null;
  title: string | null;
  authors: ReferenceAuthor[];
  year: number | null;
  doi: string | null;
  url: string | null;
  journal: string | null;
  abstract: string | null;
  fields: Record<string, ReferenceField>;
  diagnostics: ReferenceDiagnostic[];
}

export interface SourceFrameOptions {
  maxSourceBytes?: number;
  maxRecordBytes?: number;
  maxRecords?: number;
}

export interface ParseSourceResult {
  format: ReferenceFormat;
  sourceByteLength: number;
  records: ImportedReference[];
  diagnostics: ReferenceDiagnostic[];
}

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_MAX_RECORDS = 1_000;
const MAX_BIBTEX_STRING_DEFINITIONS = 200;
const MAX_BIBTEX_EXPANSION_LENGTH = 100_000;
const MAX_BIBTEX_NESTING = 64;

function utf8(input: string | Uint8Array): { text: string; bytes: Uint8Array; diagnostics: ReferenceDiagnostic[] } {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const diagnostics: ReferenceDiagnostic[] = [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
    diagnostics.push({ code: "invalid_utf8", severity: "error", message: "Source is not valid UTF-8; replacement characters were used." });
  }
  return { text, bytes, diagnostics };
}

function removeOptionalBom(text: string, bytes: Uint8Array): { text: string; byteOffsetBase: number } {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { text: hasBom && text.startsWith("\uFEFF") ? text.slice(1) : text, byteOffsetBase: hasBom ? 3 : 0 };
}

function characterByteOffsets(text: string, byteOffsetBase = 0): number[] {
  const offsets = new Array<number>(text.length + 1);
  let byte = byteOffsetBase;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = byte;
    const codePoint = text.codePointAt(i) ?? 0;
    const width = Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    byte += width;
    if (codePoint > 0xffff) {
      offsets[++i] = byte;
    }
  }
  offsets[text.length] = byte;
  return offsets;
}

function spanFor(offsets: number[], start: number, end: number): ByteSpan {
  return { startByte: offsets[Math.max(0, start)] ?? 0, endByte: offsets[Math.max(0, end)] ?? offsets[offsets.length - 1] ?? 0 };
}

function stripMarkup(value: string): string {
  const accentMap: Record<string, Record<string, string>> = {
    "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý" },
    "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
    "\"": { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü" },
    "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
    "~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
    "c": { c: "ç", C: "Ç" },
  };
  const protectedBraces: string[] = [];
  let protectedTilde = false;
  const protectBrace = (brace: string) => {
    const index = protectedBraces.push(brace) - 1;
    return `\u0000${index}\u0000`;
  };
  return value
    .replace(/[\u000e\u000f]/g, "")
    .replace(/<\/?(?:span|b|i|em|strong|code|a|p|br|small|sup|sub|div|h[1-6])(?:\s[^>]*)?>/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\\textbackslash\s*\{\s*\}/gi, "\\")
    .replace(/\\\^\s*\{\s*\}/g, "^")
    .replace(/\\~\s*\{\s*\}/g, () => { protectedTilde = true; return "\u0000tilde\u0000"; })
    .replace(/\\([{}])/g, (_match, brace: string) => protectBrace(brace))
    .replace(/\\(['`\"^~])\s*\{?([A-Za-z])\}?/g, (_match, accent: string, character: string) => accentMap[accent]?.[character] ?? character)
    .replace(/\\c\s*\{?([A-Za-z])\}?/g, (_match, character: string) => accentMap.c[character] ?? character)
    .replace(/\\([%&_#$])/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .normalize("NFC")
    .replace(/\u0000tilde\u0000/g, protectedTilde ? "~" : "")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedBraces[Number(index)] ?? "")
    .trim();
}

const knownLatexCommands = new Set([
  "textit", "textbf", "textsc", "texttt", "emph", "mkbibemph", "mkbibbold",
  "itshape", "bfseries", "rmfamily", "sffamily", "textrm", "textsf", "textup",
  "textsl", "textnormal", "underline", "textbackslash", "url", "href", "LaTeX", "TeX",
]);

function unknownLatexCommands(value: string): string[] {
  return [...value.matchAll(/\\([A-Za-z@]+)\*?/g)]
    .map((match) => match[1])
    .filter((command, index, commands) => !knownLatexCommands.has(command) && commands.indexOf(command) === index);
}

function plain(value: unknown): string {
  return stripMarkup(typeof value === "string" ? value : value == null ? "" : String(value));
}

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase();
}

function fieldState(value: string | null): ReferenceFieldState {
  return value == null ? "missing" : value.trim().length === 0 ? "empty" : "present";
}

function createField(name: string, rawValue: string | null, value: string | null, span?: ByteSpan): ReferenceField {
  return { name, rawValue, value, state: fieldState(value), ...(span ? { span } : {}) };
}

function parseAuthor(value: string): ReferenceAuthor {
  const raw = plain(value).trim();
  if (!raw) return { family: null, given: null, suffix: null, literal: null, raw };
  if (raw.includes(",")) {
    const parts = raw.split(",").map((part) => part.trim());
    return { family: parts[0] || null, given: parts[1] || null, suffix: parts[2] || null, literal: null, raw };
  }
  const words = raw.split(/\s+/);
  return { family: words.pop() ?? null, given: words.join(" ") || null, suffix: null, literal: null, raw };
}

function asAuthors(value: unknown): ReferenceAuthor[] {
  if (!Array.isArray(value)) return [];
  return value.map((author) => {
    if (typeof author === "string") return parseAuthor(author);
    if (!author || typeof author !== "object") return parseAuthor(String(author ?? ""));
    const item = author as Record<string, unknown>;
    const family = item.lastName == null ? null : plain(item.lastName);
    const given = item.firstName == null ? null : plain(item.firstName);
    const suffix = item.suffix == null ? null : plain(item.suffix);
    const literal = item.name == null ? null : plain(item.name);
    const raw = literal || [given, family, suffix].filter(Boolean).join(" ");
    return { family, given, suffix, literal, raw };
  });
}

function splitBibtexFields(body: string, bodyStart: number): Array<{ name: string; rawValue: string; valueStart: number; valueEnd: number; nameStart: number; end: number }> {
  const fields: Array<{ name: string; rawValue: string; valueStart: number; valueEnd: number; nameStart: number; end: number }> = [];
  let i = 0;
  let depth = 0;
  let quote = false;
  let keyConsumed = false;
  while (i < body.length) {
    const char = body[i];
    if (char === '"' && body[i - 1] !== "\\") quote = !quote;
    if (!quote && char === "{") depth++;
    if (!quote && char === "}") depth = Math.max(0, depth - 1);
    if (!keyConsumed && !depth && char === ",") {
      keyConsumed = true;
      i++;
      continue;
    }
    if (!keyConsumed) {
      i++;
      continue;
    }
    if (!quote && !depth && /[A-Za-z]/.test(char)) {
      const nameStart = i;
      while (i < body.length && /[A-Za-z0-9_:+-]/.test(body[i])) i++;
      const name = normalizeFieldName(body.slice(nameStart, i));
      while (/\s/.test(body[i] ?? "")) i++;
      if (body[i] !== "=") { i = Math.max(i + 1, nameStart + 1); continue; }
      i++;
      while (/\s/.test(body[i] ?? "")) i++;
      const valueStart = i;
      let valueDepth = 0;
      let valueQuote = false;
      while (i < body.length) {
        const current = body[i];
        if (current === '"' && body[i - 1] !== "\\") valueQuote = !valueQuote;
        if (!valueQuote && current === "{") valueDepth++;
        if (!valueQuote && current === "}") valueDepth = Math.max(0, valueDepth - 1);
        if (!valueQuote && valueDepth === 0 && current === ",") break;
        i++;
      }
      const valueEnd = i;
      fields.push({ name, rawValue: body.slice(valueStart, valueEnd).trim(), valueStart: bodyStart + valueStart, valueEnd: bodyStart + valueEnd, nameStart: bodyStart + nameStart, end: bodyStart + valueEnd });
      continue;
    }
    i++;
  }
  return fields;
}

function bibtexRecord(frame: { text: string; start: number; end: number; diagnostics?: ReferenceDiagnostic[] }, offsets: number[], packageEntry: BibTeXEntry | undefined, globalDiagnostics: ReferenceDiagnostic[]): ImportedReference | null {
  const raw = frame.text;
  const open = raw.search(/[({]/);
  if (open < 0) {
    return {
      format: "bibtex",
      sourceSpan: spanFor(offsets, frame.start, frame.end),
      raw,
      key: null,
      entryType: raw.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || null,
      title: null,
      authors: [],
      year: null,
      doi: null,
      url: null,
      journal: null,
      abstract: null,
      fields: {},
      diagnostics: [...(frame.diagnostics ?? [])],
    };
  }
  const close = raw.lastIndexOf(raw[open] === "(" ? ")" : "}");
  const header = raw.slice(1, open).trim();
  if (/^(comment|string|preamble)$/i.test(header)) return null;
  const inner = raw.slice(open + 1, close >= open ? close : raw.length);
  const comma = inner.indexOf(",");
  const key = comma < 0 ? inner.trim() : inner.slice(0, comma).trim();
  const bodyStart = open + 1;
  const parsedFields = splitBibtexFields(inner, bodyStart);
  const fields: Record<string, ReferenceField> = {};
  const entryDiagnostics: ReferenceDiagnostic[] = [...(frame.diagnostics ?? [])];
  for (const field of parsedFields) {
    const value = plain(unbrace(field.rawValue));
    if (fields[field.name]) {
      const diagnostic = { code: "duplicate_field", severity: "warning" as const, message: `BibTeX field '${field.name}' occurs more than once.`, span: spanFor(offsets, frame.start + field.valueStart, frame.start + field.valueEnd) };
      globalDiagnostics.push(diagnostic);
      entryDiagnostics.push(diagnostic);
    }
    for (const command of unknownLatexCommands(field.rawValue)) {
      const diagnostic = { code: "unknown_latex_command", severity: "warning" as const, message: `BibTeX command '\\${command}' was removed while decoding plain Unicode metadata.`, span: spanFor(offsets, frame.start + field.valueStart, frame.start + field.valueEnd) };
      globalDiagnostics.push(diagnostic);
      entryDiagnostics.push(diagnostic);
    }
    fields[field.name] = createField(field.name, field.rawValue, value, spanFor(offsets, frame.start + field.nameStart, frame.start + field.end));
  }
  const packageFields = packageEntry?.fields ?? {};
  const packageValue = (name: string): string | null => {
    const value = packageFields[name.toLowerCase()];
    return value == null || typeof value === "object" ? null : plain(value);
  };
  const get = (...names: string[]) => names.map((name) => packageValue(name) ?? fields[name.toLowerCase()]?.value ?? null).find((value) => value != null) ?? null;
  const title = get("title");
  const packageAuthors = packageFields.author;
  const authorField = fields.author?.value;
  const authors = Array.isArray(packageAuthors)
    ? asAuthors(packageAuthors)
    : authorField ? authorField.split(/\s+and\s+/i).map(parseAuthor) : [];
  const yearValue = get("year");
  const year = yearValue && /^-?\d{4}$/.test(yearValue.trim()) ? Number(yearValue.trim()) : null;
  return {
    format: "bibtex", sourceSpan: spanFor(offsets, frame.start, frame.end), raw, key: key || null, entryType: header.toLowerCase() || null,
    title, authors, year, doi: get("doi") || null, url: get("url") || null, journal: get("journal", "journaltitle", "booktitle", "howpublished") || null, abstract: get("abstract", "annote") || null,
    fields, diagnostics: entryDiagnostics,
  };
}

/**
 * The pinned parser package is kept in the manifest for compatibility with
 * downstream adapters. The framing adapter deliberately does its own bounded
 * field scan: this keeps source byte spans exact and avoids importing parser
 * presentation markup into canonical metadata.
 */
function parseWithPackage(raw: string, diagnostics: ReferenceDiagnostic[]): BibTeXParseResult | null {
  try {
    const parsed = parseBibTeXDocument(raw, {
      english: false,
      sentenceCase: false,
      raw: true,
      applyCrossRef: false,
      verbatimFields: ["doi", "url", "eprint", "file"],
    });
    for (const error of parsed.errors) diagnostics.push({ code: "bibtex_parse_error", severity: "warning", message: error.error });
    const stringValues = Object.values(parsed.strings ?? {});
    if (stringValues.some((value) => typeof value === "string" && value.length > MAX_BIBTEX_EXPANSION_LENGTH)
      || parsed.entries.some((entry) => Object.values(entry.fields ?? {}).some((value) => typeof value === "string" && value.length > MAX_BIBTEX_EXPANSION_LENGTH))) {
      diagnostics.push({ code: "macro_expansion_limit", severity: "error", message: `BibTeX macro expansion exceeds ${MAX_BIBTEX_EXPANSION_LENGTH} characters.` });
    }
    return parsed;
  } catch (error) {
    diagnostics.push({ code: "bibtex_parse_error", severity: "error", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function scanBibtexSafety(text: string, diagnostics: ReferenceDiagnostic[]): void {
  const definitions = text.match(/@string\s*[({]/gi)?.length ?? 0;
  if (definitions > MAX_BIBTEX_STRING_DEFINITIONS) {
    diagnostics.push({ code: "string_definition_limit", severity: "error", message: `BibTeX source contains more than ${MAX_BIBTEX_STRING_DEFINITIONS} string definitions.` });
  }
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (character === "{") {
      depth += 1;
      if (depth > MAX_BIBTEX_NESTING) {
        diagnostics.push({ code: "nesting_limit", severity: "error", message: `BibTeX brace nesting exceeds ${MAX_BIBTEX_NESTING}.` });
        return;
      }
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
}

function scanSourceControls(text: string, diagnostics: ReferenceDiagnostic[]): void {
  if (text.includes("\u0000")) diagnostics.push({ code: "nul_source", severity: "error", message: "Source contains NUL bytes, which are not valid bibliographic text." });
  if ([...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(code);
  })) diagnostics.push({ code: "control_source", severity: "error", message: "Source contains disallowed control characters." });
}

function unbrace(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
  return trimmed;
}

function frameBibtex(text: string, offsets: number[], options: Required<SourceFrameOptions>, diagnostics: ReferenceDiagnostic[]): Array<{ text: string; start: number; end: number; diagnostics?: ReferenceDiagnostic[] }> {
  const frames: Array<{ text: string; start: number; end: number; diagnostics?: ReferenceDiagnostic[] }> = [];
  let i = 0;
  while (i < text.length && frames.length < options.maxRecords) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const open = text.slice(at).search(/[({]/);
    if (open < 0) {
      const diagnostic = { code: "truncated_record", severity: "error" as const, message: "BibTeX entry has no opening delimiter.", span: spanFor(offsets, at, text.length) };
      diagnostics.push(diagnostic);
      frames.push({ text: text.slice(at), start: at, end: text.length, diagnostics: [diagnostic] });
      break;
    }
    const openIndex = at + open;
    const opener = text[openIndex];
    const closer = opener === "(" ? ")" : "}";
    let depth = 1;
    let quote = false;
    let resyncAt: number | null = null;
    let exceededRecordBytes = false;
    let j = openIndex + 1;
    for (; j < text.length; j++) {
      const current = text[j];
      if (current === '"' && text[j - 1] !== "\\") quote = !quote;
      // A malformed entry must not consume every later entry in the file. A
      // record marker at the beginning of a new line is a safe bounded
      // recovery point while quoted values remain protected from resync.
      if (!quote && depth > 0 && current === "@" && j > openIndex + 1 && (text[j - 1] === "\n" || text[j - 1] === "\r") && /^@[A-Za-z]/.test(text.slice(j))) {
        resyncAt = j;
        break;
      }
      if (!quote && current === opener) depth++;
      if (!quote && current === closer && --depth === 0) { j++; break; }
      if (offsets[j] - offsets[at] > options.maxRecordBytes) { exceededRecordBytes = true; break; }
    }
    if (j > text.length || depth !== 0) {
      const end = Math.min(text.length, resyncAt ?? j);
      const code = exceededRecordBytes ? "record_too_large" : "truncated_record";
      const message = resyncAt
        ? "BibTeX entry is not balanced before the next record."
        : exceededRecordBytes
          ? `BibTeX entry exceeds ${options.maxRecordBytes} bytes.`
          : "BibTeX entry is not balanced before the source or record bound.";
      const diagnostic = { code, severity: "error" as const, message, span: spanFor(offsets, at, end) };
      diagnostics.push(diagnostic);
      frames.push({ text: text.slice(at, end), start: at, end, diagnostics: [diagnostic] });
      i = Math.max(at + 1, resyncAt ?? end);
      continue;
    }
    if (offsets[j] - offsets[at] > options.maxRecordBytes) {
      const diagnostic = { code: "record_too_large", severity: "error" as const, message: `BibTeX entry exceeds ${options.maxRecordBytes} bytes.`, span: spanFor(offsets, at, j) };
      diagnostics.push(diagnostic);
      frames.push({ text: text.slice(at, j), start: at, end: j, diagnostics: [diagnostic] });
      i = j;
      continue;
    }
    frames.push({ text: text.slice(at, j), start: at, end: j });
    i = j;
  }
  if (frames.length >= options.maxRecords && text.slice(frames.at(-1)?.end ?? 0).includes("@")) diagnostics.push({ code: "record_limit", severity: "error", message: `Source contains more than ${options.maxRecords} records.` });
  return frames;
}

interface RisFieldFrame { tag: string; value: string; start: number; end: number; valueStart: number; valueEnd: number }
interface RisRecordFrame { text: string; start: number; end: number; fields: RisFieldFrame[]; diagnostics?: ReferenceDiagnostic[] }

function frameRis(text: string, offsets: number[], options: Required<SourceFrameOptions>, diagnostics: ReferenceDiagnostic[]): RisRecordFrame[] {
  const lines = text.matchAll(/^([^\r\n]*)(\r\n|\n|\r|$)/gm);
  const records: RisRecordFrame[] = [];
  let current: { start: number; end: number; fields: RisFieldFrame[]; diagnostics?: ReferenceDiagnostic[] } | null = null;
  let last: RisFieldFrame | null = null;
  let consumedOffset = 0;
  for (const match of lines) {
    const line = match[1] ?? "";
    const lineStart = match.index ?? 0;
    const lineEnd = lineStart + line.length;
    consumedOffset = lineEnd;
    const tagMatch = /^([A-Za-z0-9]{2})\s{1,2}-\s?(.*)$/.exec(line);
    if (!tagMatch) {
      if (/^\s+/.test(line) && last && current) {
        last.value += `\n${line.trim()}`;
        last.valueEnd = lineEnd;
        last.end = lineEnd;
        current.end = lineEnd;
        continue;
      }
      if (line.trim() && current) diagnostics.push({ code: "malformed_ris_line", severity: "warning", message: "RIS line does not have a two-character tag.", span: spanFor(offsets, lineStart, lineEnd) });
      continue;
    }
    const tag = tagMatch[1].toUpperCase();
    const value = tagMatch[2] ?? "";
    if (tag === "TY") {
      if (current) {
        const diagnostic = { code: "truncated_record", severity: "error" as const, message: "RIS record did not terminate with ER.", span: spanFor(offsets, current.start, current.end) };
        diagnostics.push(diagnostic);
        current.diagnostics = [...(current.diagnostics ?? []), diagnostic];
        records.push({ text: text.slice(current.start, current.end), start: current.start, end: current.end, fields: current.fields, diagnostics: current.diagnostics });
      }
      current = { start: lineStart, end: lineEnd, fields: [] };
      last = null;
    }
    if (!current) continue;
    current.end = lineEnd;
    if (tag === "ER") {
      records.push({ text: text.slice(current.start, current.end), start: current.start, end: current.end, fields: current.fields });
      current = null;
      last = null;
      if (records.length >= options.maxRecords) break;
      continue;
    }
    const valueStart = lineStart + line.indexOf(value);
    const field: RisFieldFrame = { tag, value, start: lineStart, end: lineEnd, valueStart, valueEnd: lineEnd };
    current.fields.push(field);
    last = field;
    if (offsets[lineEnd] - offsets[current.start] > options.maxRecordBytes) {
      const diagnostic = { code: "record_too_large", severity: "error" as const, message: `RIS record exceeds ${options.maxRecordBytes} bytes.`, span: spanFor(offsets, current.start, lineEnd) };
      diagnostics.push(diagnostic);
      current.diagnostics = [...(current.diagnostics ?? []), diagnostic];
      records.push({ text: text.slice(current.start, lineEnd), start: current.start, end: lineEnd, fields: current.fields, diagnostics: current.diagnostics });
      current = null;
      last = null;
    }
  }
  if (current) {
    const diagnostic = { code: "truncated_record", severity: "error" as const, message: "RIS record did not terminate with ER.", span: spanFor(offsets, current.start, current.end) };
    diagnostics.push(diagnostic);
    current.diagnostics = [...(current.diagnostics ?? []), diagnostic];
    records.push({ text: text.slice(current.start, current.end), start: current.start, end: current.end, fields: current.fields, diagnostics: current.diagnostics });
  }
  if (records.length > options.maxRecords || (records.length >= options.maxRecords && /^TY\s{1,2}-/m.test(text.slice(consumedOffset)))) {
    records.splice(options.maxRecords);
    diagnostics.push({ code: "record_limit", severity: "error", message: `Source contains more than ${options.maxRecords} records.` });
  }
  return records;
}

function risRecord(frame: ReturnType<typeof frameRis>[number], text: string, offsets: number[]): ImportedReference {
  const fields: Record<string, ReferenceField> = {};
  const values = new Map<string, string[]>();
  const authorValues: string[] = [];
  for (const item of frame.fields) {
    if (item.tag === "ER") continue;
    const value = stripMarkup(item.value.trim());
    const name = item.tag.toLowerCase();
    (values.get(name) ?? (values.set(name, []), values.get(name)!)).push(value);
    if (item.tag === "AU" || item.tag === "A1") authorValues.push(value);
    fields[name] = createField(name, item.value, value, spanFor(offsets, item.start, item.end));
  }
  const get = (...names: string[]) => names.map((name) => values.get(name.toLowerCase())?.[0]).find((value) => value != null) ?? null;
  const title = get("ti", "t1");
  const yearText = get("py", "y1", "da");
  const yearMatch = yearText?.match(/\b\d{4}\b/);
  return {
    format: "ris", sourceSpan: spanFor(offsets, frame.start, frame.end), raw: text.slice(frame.start, frame.end), key: get("id") || null,
    entryType: get("ty"), title, authors: authorValues.map(parseAuthor), year: yearMatch ? Number(yearMatch[0]) : null,
    doi: get("do"), url: get("ur", "lu"), journal: get("jo", "jf", "t2", "j2"), abstract: get("ab", "n2"), fields, diagnostics: [...(frame.diagnostics ?? [])],
  };
}

function optionValues(options: SourceFrameOptions): Required<SourceFrameOptions> {
  return { maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES, maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES, maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS };
}

export function parseBibtexSource(input: string | Uint8Array, options: SourceFrameOptions = {}): ParseSourceResult {
  const decoded = utf8(input);
  const limit = optionValues(options);
  const diagnostics = [...decoded.diagnostics];
  const source = removeOptionalBom(decoded.text, decoded.bytes);
  const text = source.text;
  scanSourceControls(text, diagnostics);
  scanBibtexSafety(text, diagnostics);
  if (decoded.bytes.byteLength > limit.maxSourceBytes) diagnostics.push({ code: "source_too_large", severity: "error", message: `Source exceeds ${limit.maxSourceBytes} bytes.` });
  const boundedBytes = decoded.bytes.byteLength > limit.maxSourceBytes ? decoded.bytes.slice(0, limit.maxSourceBytes) : decoded.bytes;
  const boundedText = boundedBytes.byteLength === decoded.bytes.byteLength ? text : new TextDecoder().decode(boundedBytes);
  const boundedSource = removeOptionalBom(boundedText, decoded.bytes);
  const offsets = characterByteOffsets(boundedSource.text, boundedSource.byteOffsetBase);
  const packageResult = parseWithPackage(boundedSource.text, diagnostics);
  // The maintained parser excludes @string/@comment/@preamble frames from
  // `entries`, while our byte-preserving framer keeps those frames so their
  // spans and warnings remain auditable. Match by the original entry input
  // instead of assuming the two frame arrays have identical indexes.
  const packageEntries = new Map((packageResult?.entries ?? []).map((entry) => [entry.input.trim(), entry]));
  const frames = frameBibtex(boundedSource.text, offsets, limit, diagnostics);
  const records = frames.map((frame) => bibtexRecord(frame, offsets, packageEntries.get(frame.text.trim()), diagnostics)).filter((record): record is ImportedReference => Boolean(record));
  const seenKeys = new Set<string>();
  for (const record of records) {
    if (!record.key) continue;
    const normalizedKey = record.key.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      const diagnostic = { code: "duplicate_key", severity: "warning" as const, message: `BibTeX citation key '${record.key}' occurs more than once.`, span: record.sourceSpan };
      record.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
    }
    seenKeys.add(normalizedKey);
  }
  return { format: "bibtex", sourceByteLength: decoded.bytes.byteLength, records, diagnostics };
}

export function parseRisSource(input: string | Uint8Array, options: SourceFrameOptions = {}): ParseSourceResult {
  const decoded = utf8(input);
  const limit = optionValues(options);
  const diagnostics = [...decoded.diagnostics];
  const source = removeOptionalBom(decoded.text, decoded.bytes);
  scanSourceControls(source.text, diagnostics);
  if (decoded.bytes.byteLength > limit.maxSourceBytes) diagnostics.push({ code: "source_too_large", severity: "error", message: `Source exceeds ${limit.maxSourceBytes} bytes.` });
  const boundedBytes = decoded.bytes.byteLength > limit.maxSourceBytes ? decoded.bytes.slice(0, limit.maxSourceBytes) : decoded.bytes;
  const boundedSource = removeOptionalBom(boundedBytes.byteLength === decoded.bytes.byteLength ? decoded.text : new TextDecoder().decode(boundedBytes), boundedBytes);
  const offsets = characterByteOffsets(boundedSource.text, boundedSource.byteOffsetBase);
  const records = frameRis(boundedSource.text, offsets, limit, diagnostics).map((frame) => risRecord(frame, boundedSource.text, offsets));
  return { format: "ris", sourceByteLength: decoded.bytes.byteLength, records, diagnostics };
}

export function parseReferenceSource(format: ReferenceFormat, input: string | Uint8Array, options: SourceFrameOptions = {}): ParseSourceResult {
  return format === "bibtex" ? parseBibtexSource(input, options) : parseRisSource(input, options);
}

export const parseBibTeXSource = parseBibtexSource;
export const parseRISSource = parseRisSource;
export const normalizeReferenceDoi = normalizeDoiForComparison;
export const normalizeReferenceTitle = normalizeTitleForComparison;
