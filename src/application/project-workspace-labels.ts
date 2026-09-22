const TOKEN_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  id: "ID",
  pdf: "PDF",
  sha: "SHA",
  utc: "UTC",
};

export function humanizeWorkspaceToken(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => TOKEN_OVERRIDES[word.toLowerCase()] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

export function humanizeBatchState(value: string | null | undefined): string {
  return humanizeWorkspaceToken(value);
}

export function humanizeBatchReason(value: string | null | undefined): string {
  return humanizeWorkspaceToken(value);
}

export function humanizeBatchDisposition(value: string | null | undefined): string {
  return humanizeWorkspaceToken(value);
}

export function formatAuditTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
