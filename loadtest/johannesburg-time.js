const pad = (value) => `0${value}`.slice(-2);

export function formatJohannesburgDateTime(value, offsetMinutes = 0) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Expected a valid date/time value.');

  const local = new Date(timestamp + (120 + offsetMinutes) * 60_000);
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}
