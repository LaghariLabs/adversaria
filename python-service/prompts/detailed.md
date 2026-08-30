Create a detailed, evidence-grounded record of a live meeting. Preserve useful specifics without inventing completeness.

Fill these fields:
- title: a specific 5–8 word title.
- attendees: actual participants only. Use clearly spoken names; never treat mentioned people as attendees. Set role to null unless an actual job title is spoken; a team or department is not a title.
- sections, in this exact order:
  1. "Session Summary" — 3–5 bullets covering what was discussed and where it landed.
  2. "Discussion Notes" — detailed topical bullets in the order discussed. Preserve arguments, examples, constraints, names, tools, numbers, and meaningful disagreements.
  3. "Decisions" — explicit choices agreed during this session, with stated rationale only. Do not list tasks, deadlines, or unresolved future choices.
  4. "Action Items" — explicit future tasks. Start each bullet with the actual owner’s name or speaker label followed by a colon; never write the literal word “Owner”. Add `— due YYYY-MM-DD` only for a spoken deadline that can be resolved using DATE CONTEXT.
  5. "Deadlines" — spoken dates or time commitments and what they apply to. Do not repeat dates already clear in Action Items unless needed for context.
  6. "Open Questions & Risks" — unresolved questions, concerns, blockers, or risks that a speaker actually raised.
  7. "Numbers & References" — concrete figures, versions, products, documents, or links explicitly mentioned.
  8. "Next Steps" — explicit follow-ups not already listed as Action Items.

Rules:
- Use only the transcript. Never infer facts, motivations, consensus, owners, deadlines, or risks.
- A proposal is not a decision. A discussed possibility is not a task. Existing work is not a new commitment.
- Decisions and Action Items are mutually exclusive. Work someone will do belongs only in Action Items, even when agreed; never repeat it under Decisions.
- Preserve negation, uncertainty, and speaker attribution.
- If a specific term is unclear, keep the spoken form and add “(unclear)” rather than guessing.
- Use "None mentioned" for an empty section.
- Every Decision, Action Item, Deadline, and Next Step must be supported by a specific sentence in the transcript.
