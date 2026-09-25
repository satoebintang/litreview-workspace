import postgres from "postgres";

export type LockRaceCoordinator = {
  blocker: postgres.Sql;
  observer: postgres.Sql;
  close(): Promise<void>;
};

export function lockTimeoutUrl(databaseUrl: string, lockTimeoutMs = 15_000, statementTimeoutMs = 25_000) {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options")?.trim();
  const options = [existing, `-c lock_timeout=${lockTimeoutMs}`, `-c statement_timeout=${statementTimeoutMs}`].filter(Boolean).join(" ");
  url.searchParams.set("options", options);
  return url.toString();
}

export function createLockRaceCoordinator(databaseUrl: string): LockRaceCoordinator {
  const blocker = postgres(databaseUrl, { max: 2, prepare: false });
  const observer = postgres(databaseUrl, { max: 1, prepare: false });
  return {
    blocker,
    observer,
    async close() {
      await Promise.all([blocker.end(), observer.end()]);
    },
  };
}

export async function holdTransaction(
  client: postgres.Sql,
  acquire: (tx: postgres.TransactionSql) => Promise<void>,
) {
  let readyResolve!: (pid: number) => void;
  let readyReject!: (error: unknown) => void;
  let releaseResolve!: () => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const releaseGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const transaction = client.begin(async (tx) => {
    try {
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      await acquire(tx);
      readyResolve(Number(pid));
      await releaseGate;
    } catch (error) {
      readyReject(error);
      throw error;
    }
  });
  const pid = await ready;
  return {
    pid,
    release() { releaseResolve(); },
    transaction,
  };
}

export async function waitForBlockedSessions(
  observer: postgres.Sql,
  blockerPid: number,
  minimumCount = 1,
  queryIncludes?: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const blocked = await observer`
      with recursive waiters(pid, path) as (
        select activity.pid, array[activity.pid]::int[]
        from pg_stat_activity activity
        where activity.datname=current_database()
          and activity.pid <> pg_backend_pid()
          and activity.wait_event_type='Lock'
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
        union all
        select activity.pid, waiters.path || activity.pid
        from pg_stat_activity activity
        join waiters on waiters.pid = any(pg_blocking_pids(activity.pid))
        where activity.datname=current_database()
          and activity.pid <> pg_backend_pid()
          and activity.wait_event_type='Lock'
          and not activity.pid = any(waiters.path)
      )
      select distinct activity.pid, activity.query
      from waiters
      join pg_stat_activity activity on activity.pid=waiters.pid
    `;
    const normalize = (value: string) => value.toLowerCase().replaceAll('"', "");
    const matching = queryIncludes
      ? blocked.filter((row) => normalize(String(row.query)).includes(normalize(queryIncludes)))
      : blocked;
    if (matching.length >= minimumCount) return matching.map((row) => Number(row.pid));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = await observer`
    select pid, query, wait_event_type, pg_blocking_pids(pid) as blockers
    from pg_stat_activity
    where datname=current_database() and pid <> pg_backend_pid() and wait_event_type='Lock'
  `;
  const summary = activity.map((row) => `${row.pid}: ${String(row.query).slice(0, 180)} [blockers=${JSON.stringify(row.blockers)}]`).join("; ");
  throw new Error(`Timed out waiting for ${minimumCount} session(s) blocked by backend ${blockerPid}${queryIncludes ? ` while running ${queryIncludes}` : ""}${summary ? `; lock waits: ${summary}` : "; no lock waits visible"}`);
}

export async function completeWhileLockHeld<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not complete while the unrelated lock was held (${timeoutMs} ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
