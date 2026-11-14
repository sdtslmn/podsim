// Cron schedule parsing for CronJobs: five fields (minute hour day-of-month
// month day-of-week), lists, ranges, steps, month and weekday names, and
// the @hourly style macros. Times are evaluated in UTC.

export interface Schedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(text: string, min: number, max: number, names: string[] | undefined, nameBase: number, label: string): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  let star = false;
  const value = (v: string): number => {
    const lower = v.toLowerCase();
    if (names) {
      const idx = names.indexOf(lower);
      if (idx >= 0) return idx + nameBase;
    }
    if (!/^\d+$/.test(v)) throw new Error(`failed to parse int from ${v}: strconv.Atoi: parsing "${v}": invalid syntax`);
    return parseInt(v, 10);
  };
  for (const part of text.split(",")) {
    if (!part) throw new Error(`failed to parse ${label}: empty value`);
    const [range, stepText] = part.split("/");
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || parseInt(stepText, 10) === 0) throw new Error(`failed to parse int from ${stepText}: strconv.Atoi: parsing "${stepText}": invalid syntax`);
      step = parseInt(stepText, 10);
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
      if (stepText === undefined) star = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = value(a);
      hi = value(b);
    } else {
      lo = value(range);
      hi = stepText !== undefined ? max : lo;
    }
    if (hi > max) throw new Error(`end of range (${hi}) above maximum (${max}): ${part}`);
    if (lo < min) throw new Error(`beginning of range (${lo}) below minimum (${min}): ${part}`);
    if (lo > hi) throw new Error(`beginning of range (${lo}) beyond end of range (${hi}): ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(label === "dow" ? v % 7 : v);
  }
  return { set, star };
}

/** Parse a schedule, or throw an Error with a message like the API server's. */
export function parseSchedule(expr: string): Schedule {
  const text = (MACROS[expr.trim().toLowerCase()] ?? expr).trim();
  if (expr.trim().startsWith("@") && !MACROS[expr.trim().toLowerCase()]) {
    if (expr.trim().startsWith("@every")) throw new Error(`@every descriptors are not supported, use a five field schedule`);
    throw new Error(`unrecognized descriptor: ${expr.trim()}`);
  }
  if (/^TZ=|^CRON_TZ=/.test(text)) throw new Error("CRON_TZ or TZ used in schedule is not supported, please use the timeZone field instead");
  const fields = text.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new Error(`expected exactly 5 fields, found ${fields.length}: [${fields.join(" ")}]`);
  const minute = parseField(fields[0], 0, 59, undefined, 0, "minute");
  const hour = parseField(fields[1], 0, 23, undefined, 0, "hour");
  const dom = parseField(fields[2], 1, 31, undefined, 0, "dom");
  const month = parseField(fields[3], 1, 12, MONTHS, 1, "month");
  const dow = parseField(fields[4], 0, 7, DAYS, 0, "dow");
  return { minute: minute.set, hour: hour.set, dom: dom.set, month: month.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

function dayMatches(s: Schedule, d: Date): boolean {
  const domOk = s.dom.has(d.getUTCDate());
  const dowOk = s.dow.has(d.getUTCDay());
  if (s.domStar || s.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/** The first scheduled time strictly after `afterMs`. Returns undefined if none within ~5 years. */
export function nextRun(s: Schedule, afterMs: number): number | undefined {
  const d = new Date(Math.floor(afterMs / 60000) * 60000 + 60000);
  const limit = afterMs + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (!s.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

/** The latest scheduled time in (afterMs, untilMs], and how many were missed in between. */
export function lastRunBetween(s: Schedule, afterMs: number, untilMs: number): { time?: number; missed: number } {
  let t = afterMs;
  let last: number | undefined;
  let missed = 0;
  for (let i = 0; i < 1000; i++) {
    const n = nextRun(s, t);
    if (n === undefined || n > untilMs) break;
    if (last !== undefined) missed++;
    last = n;
    t = n;
  }
  return { time: last, missed };
}
