/**
 * Display-only labels for prompt-template slugs.
 *
 * The slug is the API key — the Python service validates it as a path-safe
 * lowercase-hyphenated name — so it must stay untouched everywhere it is sent
 * to the backend or used as an `<option value>`. This module only decides what
 * the user *reads*.
 */

/** Curated labels for the templates the app ships with. */
const CURATED = new Map<string, string>([
  ["general", "General"],
  ["one-on-one", "One-on-one"],
  ["client-meeting", "Client meeting"],
  ["brainstorm", "Brainstorm"],
  ["interview", "Interview"],
  ["detailed", "Detailed"],
  ["youtube", "YouTube"],
  ["note", "Note"],
  ["brain-dump", "Brain dump"],
]);

/**
 * Human label for a template slug. Curated labels win; anything else (users can
 * save their own templates) is prettified — hyphens/underscores become spaces
 * and the first letter is capitalised, e.g. `q3-planning` → `Q3 planning`.
 * Input that can't be prettified (empty, whitespace, punctuation only) is
 * returned unchanged.
 */
export function templateDisplayName(slug: string): string {
  const curated = CURATED.get(slug);
  if (curated) return curated;
  const spaced = slug.replace(/[-_]+/g, " ").trim();
  if (!spaced) return slug;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
