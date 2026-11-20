// Timezone-aware calendar-day arithmetic.
//
// Storage convention: every timestamp is an integer UTC millisecond (epoch).
// Billing days are *calendar days in the subscription's IANA timezone*, so a
// plan change "on 2026-03-15" takes effect at local midnight, not UTC midnight.
// Two passes of Intl.DateTimeFormat give us tz offsets without any tz library.

function partsAt(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return p;
}

/** Offset in milliseconds between UTC and the wall clock in `timeZone` at `utcMs`. */
export function tzOffsetMs(utcMs, timeZone) {
  const p = partsAt(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

/** UTC ms of local calendar midnight for the given local date parts in `timeZone`. */
export function localMidnightUtc(year, month /* 1-12 */, day, timeZone) {
  // First guess treating local time == UTC, then correct with the real offset.
  const guess = Date.UTC(year, month - 1, day);
  return guess - tzOffsetMs(guess, timeZone);
}

/** Parse "YYYY-MM-DD" -> UTC ms of local midnight in timeZone. */
export function localDateToUtc(localDate, timeZone) {
  const [y, m, d] = localDate.split('-').map(Number);
  return localMidnightUtc(y, m, d, timeZone);
}

export function utcToLocalDayIndex(utcMs, timeZone) {
  const p = partsAt(new Date(utcMs), timeZone);
  return Math.floor(Date.UTC(+p.year, +p.month - 1, +p.day) / 86_400_000);
}

/** "YYYY-MM-DD" label for a UTC ms in the given timezone. */
export function utcToLocalDate(utcMs, timeZone) {
  const p = partsAt(new Date(utcMs), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addLocalDays(localDate, days) {
  const [y, m, d] = localDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * Add calendar months with end-of-month clamping: Jan 31 + 1 month -> Feb 28/29.
 * Keeps the *day of month* of the anchor, matching how recurring billing works.
 */
export function addLocalMonthsClamped(localDate, months) {
  const [y, m, d] = localDate.split('-').map(Number);
  const zeroBased = m - 1 + months;
  const year = y + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12; // 0-11
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTarget);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function nowUtcMs() {
  return Date.now();
}

export function toIso(utcMs) {
  return new Date(utcMs).toISOString();
}

/**
 * Inclusive count of whole local calendar days inside [startUtc, endUtc),
 * where both boundaries are local midnights. Equals (end-start)/86.4e6 but
 * derived from day indexes so DST "short/long" days cannot skew the count.
 */
export function countLocalDays(startUtc, endUtc, timeZone) {
  return utcToLocalDayIndex(endUtc, timeZone) - utcToLocalDayIndex(startUtc, timeZone);
}
