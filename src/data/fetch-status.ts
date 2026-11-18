/**
 * Whether each chamber's last fetch worked. A failure is kept, with when it started,
 * until a fetch of that chamber succeeds, so a report built in the meantime (even one
 * rebuilt with --no-fetch-trades) says its filings are out of date.
 */
import { loadData, saveData } from "../utils/storage.js";

export type Chamber = "house" | "senate";

export interface FetchFailure {
  chamber: Chamber;
  /** First failed fetch of this outage */
  since: string;
  /** Latest failed fetch */
  lastFailedAt: string;
  failedRuns: number;
  error: string;
}

const FETCH_STATUS_FILE = "fetch-status.json";

type FetchStatus = Partial<Record<Chamber, FetchFailure>>;

async function load(): Promise<FetchStatus> {
  return (await loadData<FetchStatus>(FETCH_STATUS_FILE))?.data ?? {};
}

/** The update for one fetch: a failure extends an open outage or starts one; success ends it. */
export function nextFetchStatus(status: FetchStatus, chamber: Chamber, error: string | null, now = new Date().toISOString()): FetchStatus {
  const next = { ...status };
  if (!error) {
    delete next[chamber];
    return next;
  }
  const open = status[chamber];
  next[chamber] = { chamber, since: open?.since ?? now, lastFailedAt: now, failedRuns: (open?.failedRuns ?? 0) + 1, error };
  return next;
}

export async function recordFetchResult(chamber: Chamber, error: string | null): Promise<void> {
  const status = await load();
  if (!error && !status[chamber]) return;
  await saveData(FETCH_STATUS_FILE, nextFetchStatus(status, chamber, error));
}

export async function loadFetchFailures(): Promise<FetchFailure[]> {
  return Object.values(await load()).filter((f): f is FetchFailure => !!f);
}
