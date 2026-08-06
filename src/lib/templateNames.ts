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

/** Turn anything a person types into a template name the service accepts.
 *
 *  The sidecar validates names against `^[a-z0-9][a-z0-9-]{0,48}$`
 *  (`config._safe_name`) and returns 400 for anything else. Now that the app
 *  drafts a template from a sentence, users name it in a sentence too — "daily
 *  team standup" was rejected outright. Slugify instead of refusing: the rule is
 *  a storage constraint, not something the user should have to learn.
 */
export function templateSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49)
    .replace(/-+$/g, "");
}
