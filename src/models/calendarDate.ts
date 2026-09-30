/**
 * Calendar dates (`YYYY-MM-DD`): a day, not an instant, so they are compared
 * as strings in the user's local calendar and never parsed into a `Date`
 * (which would pin them to UTC midnight). One rule, shared by the models and
 * the server's validator, so the client never meets a date the server would
 * have refused.
 */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A well-formed `YYYY-MM-DD` naming a real day (`2026-02-30` is not). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // arithmetic, not a Date round trip: `Date.UTC` maps years 0–99 to 1900–1999
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/** `YYYY-MM-DD` of `date` in the local time zone: the calendar the user sees dates in. */
export function localCalendarDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
