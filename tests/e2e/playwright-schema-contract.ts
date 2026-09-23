import { createHash } from "node:crypto";
import path from "node:path";

export type MigrationJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type MigrationJournal = {
  version: string;
  entries: MigrationJournalEntry[];
};

export type ExpectedMigration = MigrationJournalEntry & {
  id: number;
  hash: string;
};

export type MigrationRow = {
  id: number | string;
  hash: string;
  created_at: number | string;
};

export type DrizzleSnapshotTable = {
  name: string;
  columns: Record<string, { name: string }>;
};

export type DrizzleSnapshot = {
  tables: Record<string, DrizzleSnapshotTable>;
};

export type PublicSchema = Record<string, string[]>;

export type PublicSchemaRow = {
  table_name: string;
  column_name: string;
};

export type PublicSchemaDiff = {
  missingTables: string[];
  unexpectedTables: string[];
  missingColumns: string[];
  unexpectedColumns: string[];
};

export function buildMigrationManifest(
  journal: MigrationJournal,
  readMigrationSql: (tag: string) => Uint8Array,
): ExpectedMigration[] {
  if (!journal || typeof journal.version !== "string" || !Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Migration journal must include a version and at least one entry");
  }

  const seenTags = new Set<string>();
  return journal.entries.map((entry, index) => {
    if (entry.idx !== index) {
      throw new Error(`Migration journal order is invalid at entry ${index}: expected idx ${index}, found ${entry.idx}`);
    }
    if (entry.version !== journal.version) {
      throw new Error(`Migration journal version mismatch for ${entry.tag}: expected ${journal.version}, found ${entry.version}`);
    }
    if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag) || seenTags.has(entry.tag)) {
      throw new Error(`Migration journal contains an invalid or duplicate tag: ${entry.tag}`);
    }
    if (!Number.isSafeInteger(entry.when) || entry.when < 0) {
      throw new Error(`Migration journal contains an invalid timestamp for ${entry.tag}`);
    }
    seenTags.add(entry.tag);

    const hash = createHash("sha256").update(readMigrationSql(entry.tag)).digest("hex");
    return { ...entry, id: index + 1, hash };
  });
}

export function getMigrationRowMismatches(expected: ExpectedMigration[], actual: MigrationRow[]): string[] {
  const mismatches = expected.flatMap((migration, index) => {
    const row = actual[index];
    if (!row) return [`${migration.tag} is missing`];
    const found = `${row.id}/${row.hash}/${row.created_at}`;
    if (Number(row.id) !== migration.id || row.hash !== migration.hash || Number(row.created_at) !== migration.when) {
      return [`${migration.tag} expected ${migration.id}/${migration.hash}/${migration.when}, found ${found}`];
    }
    return [];
  });

  if (actual.length > expected.length) {
    mismatches.push(`database has ${actual.length - expected.length} unexpected migration row(s)`);
  }
  return mismatches;
}

export function getLatestSnapshotPath(migrationFolder: string, migrations: ExpectedMigration[]): string {
  const latest = migrations.at(-1);
  if (!latest) throw new Error("Cannot derive a Drizzle snapshot path from an empty migration chain");
  return path.join(migrationFolder, "meta", `${String(latest.idx).padStart(4, "0")}_snapshot.json`);
}

export function derivePublicSchema(snapshot: DrizzleSnapshot): PublicSchema {
  if (!snapshot || !snapshot.tables || typeof snapshot.tables !== "object") {
    throw new Error("Drizzle snapshot does not contain a tables object");
  }

  const schema: PublicSchema = {};
  for (const [qualifiedName, table] of Object.entries(snapshot.tables)) {
    if (!qualifiedName.startsWith("public.")) continue;
    const tableName = qualifiedName.slice("public.".length);
    if (!tableName || table.name !== tableName || !table.columns || typeof table.columns !== "object") {
      throw new Error(`Drizzle snapshot has invalid public table metadata for ${qualifiedName}`);
    }

    const columns = Object.entries(table.columns).map(([key, column]) => {
      if (!column || column.name !== key) {
        throw new Error(`Drizzle snapshot has invalid column metadata for ${qualifiedName}.${key}`);
      }
      return column.name;
    });
    schema[tableName] = columns.sort((left, right) => left.localeCompare(right));
  }

  return Object.fromEntries(Object.entries(schema).sort(([left], [right]) => left.localeCompare(right)));
}

export function comparePublicSchema(expected: PublicSchema, rows: PublicSchemaRow[]): PublicSchemaDiff {
  const actual: PublicSchema = {};
  for (const row of rows) {
    (actual[row.table_name] ??= []).push(row.column_name);
  }
  for (const columns of Object.values(actual)) {
    columns.sort((left, right) => left.localeCompare(right));
  }

  const expectedTables = Object.keys(expected).sort();
  const actualTables = Object.keys(actual).sort();
  const expectedTableSet = new Set(expectedTables);
  const actualTableSet = new Set(actualTables);
  const missingTables = expectedTables.filter((table) => !actualTableSet.has(table));
  const unexpectedTables = actualTables.filter((table) => !expectedTableSet.has(table));
  const missingColumns: string[] = [];
  const unexpectedColumns: string[] = [];

  for (const table of expectedTables) {
    const expectedColumns = new Set(expected[table]);
    const actualColumns = new Set(actual[table] ?? []);
    for (const column of expected[table]) {
      if (!actualColumns.has(column)) missingColumns.push(`${table}.${column}`);
    }
    for (const column of actual[table] ?? []) {
      if (!expectedColumns.has(column)) unexpectedColumns.push(`${table}.${column}`);
    }
  }

  return { missingTables, unexpectedTables, missingColumns, unexpectedColumns };
}

export function formatPublicSchemaDiff(diff: PublicSchemaDiff): string[] {
  return [
    ...diff.missingTables.map((table) => `missing table ${table}`),
    ...diff.unexpectedTables.map((table) => `unexpected table ${table}`),
    ...diff.missingColumns.map((column) => `missing column ${column}`),
    ...diff.unexpectedColumns.map((column) => `unexpected column ${column}`),
  ];
}
