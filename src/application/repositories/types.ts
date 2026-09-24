import type { Database } from "@/db/client";

export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
