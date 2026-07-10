export function stepElevation(current: number, wheelDelta: number, interval: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(interval) || interval <= 0 || wheelDelta === 0) {
    return current;
  }
  const stepped = wheelDelta < 0
    ? Math.floor((current + interval) / interval + 1e-8) * interval
    : Math.ceil((current - interval) / interval - 1e-8) * interval;
  return Object.is(stepped, -0) ? 0 : stepped;
}
