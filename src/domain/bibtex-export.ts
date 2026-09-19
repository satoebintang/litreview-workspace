import { createHash } from "node:crypto";
import type { ImportedReference, ReferenceAuthor } from "./reference-import";

export type BibtexExportInput = Partial<Omit<ImportedReference, "authors" | "fields">> & { id?: string; paperId?: string; venue?: string | null; index?: number; authors?: Array<ReferenceAuthor | string>; fields?: ImportedReference["fields"] };

function valueOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}

export function escapeBibtexValue(value: string): string {
  let escaped = "";
  const normalized = value.replace(/\r\n?/g, "\n");
  for (const character of normalized) {
    switch (character) {
      case "\\": escaped += "\\textbackslash{}"; break;
      case "{": case "}": case "%": case "&": case "#": case "$": case "_": escaped += `\\${character}`; break;
      case "^": escaped += "\\^{}"; break;
      case "~": escaped += "\\~{}"; break;
      default: escaped += character;
    }
  }
  return escaped;
}

function authorValue(author: ReferenceAuthor | string): string {
  if (typeof author === "string") return author;
  if (author.literal) return `{${author.literal}}`;
  const family = author.family ?? "";
  const given = author.given ?? "";
  const suffix = author.suffix ?? "";
  if (family && given && suffix) return `${family}, ${given}, ${suffix}`;
  if (family && given) return `${family}, ${given}`;
  return family || given;
}

function opaqueAuthorValue(author: ReferenceAuthor | string): string {
  const value = typeof author === "string" ? author : (author.literal ?? author.raw ?? authorValue(author));
  return `{${escapeBibtexValue(value)}}`;
}

function titleKey(value: string): string {
  const words = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return (words.slice(0, 3).join("") || "reference").toLowerCase();
}

export function deriveBibtexKey(record: BibtexExportInput, index = 0): string {
  const first = record.authors?.[0];
  const family = typeof first === "string"
    ? (first.includes(",") ? first.split(",")[0] : first.trim().split(/\s+/).at(-1) ?? first)
    : first?.family;
  const familyKey = family ? family.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "") : "ref";
  const year = record.year == null ? "" : String(record.year);
  const title = titleKey(record.title ?? "");
  const identity = record.paperId ?? record.id;
  const idSuffix = identity ? createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 8) : String(index + 1);
  return `${familyKey || "ref"}${year}${title || "reference"}-${idSuffix}`;
}

function fieldEntries(record: BibtexExportInput): Array<[string, string]> {
  const known: Array<[string, string | null]> = [
    ["author", record.authors?.length ? record.authors.map(authorValue).join(" and ") : null],
    ["title", valueOf(record.title)], ["year", record.year == null ? null : String(record.year)], ["journal", valueOf(record.journal ?? record.venue)], ["doi", valueOf(record.doi)], ["url", valueOf(record.url)], ["abstract", valueOf(record.abstract)],
  ];
  const result: Array<[string, string]> = [];
  for (const [name, value] of known) if (value != null) result.push([name, value]);
  return result;
}

export function serializeBibtexRecord(record: BibtexExportInput, key?: string): string {
  const entryType = "misc";
  const resolvedKey = key || (record.paperId || record.id ? deriveBibtexKey(record, record.index ?? 0) : record.key || deriveBibtexKey(record, record.index ?? 0));
  const fields = fieldEntries(record);
  const body = fields.map(([name, value]) => {
    const serialized = name === "author"
      ? (record.authors ?? []).map(opaqueAuthorValue).join(" and ")
      : escapeBibtexValue(value);
    return `  ${name} = {${serialized}}`;
  }).join(",\n");
  return `@${entryType}{${resolvedKey}${body ? `,\n${body}` : ""}\n}`;
}

export function serializeBibtex(records: BibtexExportInput[]): string {
  const seen = new Map<string, number>();
  return records.map((record, index) => {
    const base = record.key || deriveBibtexKey({ ...record, index }, index);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const key = count === 0 ? base : `${base}-${count + 1}`;
    return serializeBibtexRecord(record, key);
  }).join("\n\n") + (records.length ? "\n" : "");
}

export const exportBibtex = serializeBibtex;
