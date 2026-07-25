/**
 * User-selectable date formatting. One module-level preference (set from config
 * on app load + on Settings save) drives every date shown in the UI and the
 * slide export, so the whole app reads dates the same way.
 */

export type DateFormat = "system" | "dmy" | "mdy" | "long" | "iso";

/** Labels for the Settings dropdown (value → human label with a live example). */
export const DATE_FORMAT_OPTIONS: { value: DateFormat; label: string }[] = [
  { value: "system", label: "System default" },
  { value: "dmy", label: "Day/Month/Year — 31/07/2026 (British)" },
  { value: "mdy", label: "Month/Day/Year — 07/31/2026 (American)" },
  { value: "long", label: "Day Month Year — 31 July 2026" },
  { value: "iso", label: "ISO — 2026-07-31" },
];

let current: DateFormat = "system";

/** Set the app-wide date format (call on config load and on Settings save). */
export function setDateFormat(fmt: string | null | undefined): void {
  const known = DATE_FORMAT_OPTIONS.some((o) => o.value === fmt);
  current = known ? (fmt as DateFormat) : "system";
}

export function getDateFormat(): DateFormat {
  return current;
}

/** The locale for the current format — for callers that build their own
 *  compact `toLocaleDateString(..., opts)` labels (e.g. "4 Jul" vs "Jul 4"). */
export function dateLocale(): string | undefined {
  return localeFor(current);
}

/** Locale to use for a given format ("system" = the runtime default). */
function localeFor(fmt: DateFormat): string | undefined {
  switch (fmt) {
    case "dmy":
    case "long":
      return "en-GB";
    case "mdy":
      return "en-US";
    case "iso":
      return "sv-SE"; // yields YYYY-MM-DD
    default:
      return undefined;
  }
}

/** Format an ISO timestamp as a date only, per the user's preference. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const fmt = current;
  const locale = localeFor(fmt);
  if (fmt === "long") {
    return d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  }
  return d.toLocaleDateString(locale);
}

/** Format an ISO timestamp as date + time, per the user's preference. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const fmt = current;
  const locale = localeFor(fmt);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (fmt === "iso") return `${formatDate(iso)} ${time}`;
  return `${formatDate(iso)}, ${time}`;
}
