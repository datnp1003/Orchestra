// Cache single-flight cho fleet snapshot — thuần (không electron), test bằng node thường.
// get(): có data → trả ngay (cũ quá staleMs → refresh nền); chưa có → chờ probe đang chạy (không probe thứ 2).
// refresh(): đang chạy → trả đúng promise đó (de-dup); xong → onChange(data mới).
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
  // ponytail: refresh() trong lúc probe khác đang chạy dùng lại kết quả probe đó (có thể bắt đầu trước khi install xong) — thêm cờ "chạy lại 1 lần" nếu thấy lệch
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
