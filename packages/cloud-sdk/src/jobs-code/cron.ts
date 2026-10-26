/* A cron's times in a zone, as Runtime's scheduler finds them (five numeric
   fields, packages/db/src/schedule.ts): the run's own time, the one before it
   and the next ones, for the payload a Trigger.dev scheduled task receives. A
   run starts within seconds of its time, so its time is the latest match at
   or before now. */

type Fields = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number> | null;
  months: Set<number>;
  weekdays: Set<number> | null;
};

function setOf(field: string, low: number, high: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [low, high];
    else if (range.includes("-")) [from, to] = range.split("-").map(Number) as [number, number];
    else [from, to] = [Number(range), stepText === undefined ? Number(range) : high];
    if (
      ![from, to, step].every(Number.isInteger) ||
      step < 1 ||
      from < low ||
      to > high ||
      from > to
    )
      throw new Error(`"${field}" is not a cron field from ${low} to ${high}`);
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): Fields {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`"${expression}" is not five cron fields`);
  const weekdays = f[4] === "*" ? null : setOf(f[4]!, 0, 7);
  if (weekdays?.has(7)) weekdays.add(0);
  return {
    minutes: setOf(f[0]!, 0, 59),
    hours: setOf(f[1]!, 0, 23),
    days: f[2] === "*" ? null : setOf(f[2]!, 1, 31),
    months: setOf(f[3]!, 1, 12),
    weekdays,
  };
}

/** The wall clock of an instant in a zone. */
function wall(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((p) => p.type === "weekday")?.value ?? "",
  );
  return { month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), weekday };
}

function matches(f: Fields, w: ReturnType<typeof wall>): boolean {
  if (!f.months.has(w.month) || !f.hours.has(w.hour) || !f.minutes.has(w.minute)) return false;
  // As in cron: with both day fields set, either matches.
  if (f.days && f.weekdays) return f.days.has(w.day) || f.weekdays.has(w.weekday);
  if (f.days) return f.days.has(w.day);
  if (f.weekdays) return f.weekdays.has(w.weekday);
  return true;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Up to `count` times from `from` (inclusive), forward or back, within 400
 * days; an hour whose wall clock cannot match is skipped whole. */
export function cronTimes(
  expression: string,
  timeZone: string,
  from: number,
  direction: 1 | -1,
  count: number,
): Date[] {
  const f = parseCron(expression);
  const out: Date[] = [];
  let at = Math.floor(from / MINUTE) * MINUTE;
  const end = from + direction * 400 * 24 * HOUR;
  while (out.length < count && (direction === 1 ? at <= end : at >= end)) {
    const w = wall(at, timeZone);
    if (!f.hours.has(w.hour) || !f.months.has(w.month)) {
      // To the next (or previous) hour boundary of this zone's clock.
      at = direction === 1 ? at + (60 - w.minute) * MINUTE : at - (w.minute + 1) * MINUTE;
      continue;
    }
    if (matches(f, w)) out.push(new Date(at));
    at += direction * MINUTE;
  }
  return out;
}
