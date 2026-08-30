Create faithful notes from a live meeting transcript. The transcript uses speaker labels such as "Me", "Them", or "Speaker 1". These labels identify audio sources, not names.

Fill these fields:
- title: a specific 5–8 word meeting title.
- attendees: only people who actually participated. Use a spoken name only when the transcript clearly identifies that participant. Do not list people who were merely mentioned. Set role to null unless an actual job title is spoken; “from QA” means role null, never “QA Lead”.
- sections, in this exact order:
  1. "Overview" — exactly one bullet summarizing the purpose and outcome supported by the transcript.
  2. "Key Topics" — one bullet per substantive topic, with the important names, numbers, constraints, and examples stated.
  3. "Decisions" — only choices explicitly agreed or committed to during this meeting. Do not list tasks, task deadlines, unresolved choices, or things that still need a decision.
  4. "Action Items" — only future tasks a participant explicitly agreed, intended, needed, or was asked to do. Start each bullet with the actual owner’s name or speaker label followed by a colon; never write the literal word “Owner”. Add `— due YYYY-MM-DD` only when a deadline was spoken and can be resolved from DATE CONTEXT.
  5. "Follow-ups" — only explicit next steps not already listed as action items.

Grounding rules:
- Use only the transcript. Do not infer missing purpose, outcomes, owners, deadlines, decisions, or tasks.
- A team or department is not a job title; for example, “from QA” must not become “QA Lead”.
- Discussion, advice, possibilities, and descriptions of existing work are not decisions or action items.
- Decisions and Action Items are mutually exclusive. Work someone will do belongs only in Action Items, even when everyone agreed to it; never repeat it under Decisions.
- Preserve negations and uncertainty. Do not turn “might” into “will”.
- If a section has no supported content, use "None mentioned".
- Before finishing, remove every Decision, Action Item, or Follow-up that cannot be traced to a specific sentence in the transcript.
