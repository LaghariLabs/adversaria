import type { TagColor } from "../types";

/** Selectable tag colors, in palette order. */
export const TAG_COLORS: TagColor[] = [
  "gray", "red", "orange", "yellow", "green", "blue", "purple",
];

// Light, saturated pastels (macOS-Finder style). The app uses a cream/light
// theme, so tags need light tinted backgrounds + a saturated text color — dark
// -900 shades all read as muddy blobs on cream. `gray` stays on the themed
// neutral surface; the rest are default Tailwind colors (not re-themed).
const PILL: Record<TagColor, string> = {
  gray: "bg-gray-800 text-gray-400",
  red: "bg-red-100 text-red-700",
  orange: "bg-orange-100 text-orange-700",
  yellow: "bg-yellow-100 text-yellow-800",
  green: "bg-green-100 text-green-700",
  blue: "bg-blue-100 text-blue-700",
  purple: "bg-purple-100 text-purple-700",
};

const DOT: Record<TagColor, string> = {
  gray: "bg-gray-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
};

/** Tailwind classes for a tag pill of the given color. */
export function tagPill(color: string): string {
  return PILL[color as TagColor] ?? PILL.gray;
}

/** Tailwind classes for a small color swatch/dot. */
export function tagDot(color: string): string {
  return DOT[color as TagColor] ?? DOT.gray;
}
