export function formatRunDuration(value) {
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.floor(Math.max(0, value) / 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function runElapsed(statistics, now = Date.now()) {
  if (!Number.isFinite(statistics?.elapsedMs)) return null;
  const observedAt = Date.parse(statistics.observedAt);
  return (
    statistics.elapsedMs +
    (statistics.active && Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : 0)
  );
}
