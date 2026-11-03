// Single-flight cache for the fleet snapshot — pure (no electron), testable with plain node.
// get(): has data → return now (older than staleMs → background refresh); none → await the running probe (no 2nd probe).
// refresh(): running → return that same promise (de-dup); done → onChange(new data).
export interface FleetCache<T> {
  get(): Promise<T>;
  refresh(): Promise<T>;
}

export function createFleetCache<T>(
  probe: () => Promise<T>,
  opts: { staleMs?: number; now?: () => number; onChange?: (v: T) => void; onError?: (err: unknown) => void } = {},
): FleetCache<T> {
  const staleMs = opts.staleMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  // ponytail: refresh() during another running probe reuses that probe's result (may have started before install finished) — add a "rerun once" flag if results drift
  const refresh = (): Promise<T> =>
    (inflight ??= probe()
      .then((v) => {
        value = { v, at: now() };
        opts.onChange?.(v);
        return v;
      })
      .finally(() => {
        inflight = null;
      }));
  return {
    async get() {
      if (!value) return refresh();
      if (now() - value.at > staleMs) refresh().catch((err) => opts.onError?.(err));
      return value.v;
    },
    refresh,
  };
}
