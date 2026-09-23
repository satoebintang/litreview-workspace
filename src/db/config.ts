function isNonblank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveDatabaseUrl(explicitUrl?: string, configuredUrl = process.env.DATABASE_URL): string {
  if (isNonblank(explicitUrl)) return explicitUrl;
  if (isNonblank(configuredUrl)) return configuredUrl;
  throw new Error("Database URL is missing. Pass an explicit URL or set DATABASE_URL to a nonblank value.");
}