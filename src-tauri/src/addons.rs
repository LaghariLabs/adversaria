//! Prebuilt workspace skills and agent roles.

pub struct BuiltinAddon {
    pub kind: &'static str,
    pub slug: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub instructions: &'static str,
}

pub const BUILTIN: &[BuiltinAddon] = &[
    BuiltinAddon {
        kind: "skill",
        slug: "deep-research",
        name: "Deep research",
        description: "Structured research from the context you have, with confidence and open questions.",
        instructions: r###"## Deep research method
1. Restate the question in one sentence and list what a complete answer must contain.
2. Inventory the context first: for every meeting, related meeting, and file in the brief, note what it says that bears on the question. Cite each source by its title or path.
3. Separate facts (stated in a source) from inferences (your reasoning). Mark every inference as such.
4. Give each conclusion a confidence: high (multiple sources agree), medium (one source), low (inference only).
5. Do not use outside knowledge or browse the web unless the brief explicitly says network access is allowed; if a fact would need it, put it under Open questions.
6. Finish with "## Open questions" and "## Suggested next steps", each as a short list.
Output: a Markdown document with the sections Question, Sources used, Findings (with confidence), Inferences, Open questions, Next steps."###,
    },
    BuiltinAddon {
        kind: "skill",
        slug: "drawio-diagram",
        name: "Draw.io diagram",
        description: "Produce an editable .drawio file (plus a short legend) that opens in draw.io desktop.",
        instructions: r###"## Draw.io diagram
If a full `drawio-skill` is available in your environment (the claude CLI loads it from the user's skills directory), use IT to author, validate, and export the diagram; treat the rest of this section only as the output contract. Otherwise follow the rules below exactly.

Deliverable: an UNCOMPRESSED draw.io file named <topic>.drawio in the output directory, plus <topic>.md with a one-paragraph legend explaining what the diagram shows and which sources it was drawn from.

File skeleton (exactly this nesting):
<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio"><diagram name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
…your cells…
</root></mxGraphModel></diagram></mxfile>

Rules:
- ids "0" and "1" are required root cells; your shapes start at id "2" and increment (2, 3, 4, …). Every id unique.
- One <mxCell vertex="1" parent="1"> per component: value is a short plain-text label, and a child <mxGeometry x="…" y="…" width="160" height="60" as="geometry"/>. Style is style="rounded=1;whiteSpace=wrap;html=1;fillColor=<fill>;strokeColor=<stroke>;" — ALWAYS colored, never left plain. Pick the pair by what the component IS, so color carries meaning:
  · app / service / UI            fill #dae8fc  stroke #6c8ebf   (blue)
  · datastore / database / cache  fill #d5e8d4  stroke #82b366   (green) — also use style prefix shape=cylinder3;
  · queue / job / background work fill #fff2cc  stroke #d6b656   (yellow)
  · gateway / entry point / API   fill #ffe6cc  stroke #d79b00   (orange)
  · external / third-party        fill #f5f5f5  stroke #666666   (grey) — add dashed=1 to its edges
  · error / risk / failure path   fill #f8cecc  stroke #b85450   (red)
  · model / AI / inference        fill #e1d5e7  stroke #9673a6   (purple)
  A decision point is style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;". Group related components in a titled container: style="swimlane;startSize=30;whiteSpace=wrap;html=1;fillColor=<the tier's fill>;strokeColor=<its stroke>;" with children using parent="<containerId>" and geometry RELATIVE to the container.
- One <mxCell edge="1" parent="1" source="<id>" target="<id>"> per relationship: value is a verb ("writes", "polls", "invalidates"), style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#4d4d4d;", and a child <mxGeometry relative="1" as="geometry"/>. Add dashed=1 for anything optional, occasional, or crossing a trust boundary.
- Lay components out on a grid in the order data flows: x increases by 220 per column, y by 120 per row. No overlapping geometry.
- Escape &amp; &lt; &gt; &quot; inside attribute values; use &#xa; (never a literal \n) for line breaks in labels; never put -- inside an XML comment.
- At most 25 cells. Close every tag: the file must be well-formed XML — it is machine-validated after the run, and an unparseable file counts as a failed deliverable.
When you cannot write files directly (local model), emit each file as a "=== FILE: <name> ===" block."###,
    },
    BuiltinAddon {
        kind: "skill",
        slug: "architecture-doc",
        name: "Architecture doc",
        description: "Turn a repo and its meetings into a grounded architecture document.",
        instructions: r###"## Architecture document
Ground everything in the folders and meetings provided; when the code and a meeting disagree, say so. Sections, in order: Context (what the system is for, one paragraph); Components (one short subsection each: responsibility, key files or modules, what it talks to); Data flow (numbered steps for the main path, then the important exceptions); Interfaces (public commands, endpoints, or schemas, as a table); Decisions (each with the alternatives considered and why, dated when a meeting gives a date); Risks and gaps (what is fragile, missing, or unverified). Reference files by path. Do not invent components you cannot find."###,
    },
    BuiltinAddon {
        kind: "skill",
        slug: "meeting-grounded-writing",
        name: "Meeting-grounded writing",
        description: "Every claim points at the meeting it came from; gaps are named, not filled.",
        instructions: r###"## Meeting-grounded writing
Every factual statement must be attributable to one of the meetings or files in the brief; cite it inline as (per "<meeting title>") the first time it is used. Never invent a decision, owner, date, or number. Quote short phrases when exact wording matters. If the brief does not settle something the document needs, write "Not covered in the meetings" there and list it under a final "## Gaps" heading. Prefer the most recent meeting when two conflict, and note the conflict."###,
    },
    BuiltinAddon {
        kind: "skill",
        slug: "marketing-copy",
        name: "Marketing copy",
        description: "Audience first, one promise per piece, concrete nouns, two variants.",
        instructions: r###"## Marketing copy
Start by naming the audience and the single promise in one line each. Then write the piece with concrete nouns and numbers from the context, active voice, and sentences a reader can say out loud. Forbidden: "revolutionary", "seamless", "cutting-edge", "unlock", "empower", "game-changing", exclamation marks, and any claim the context does not support. Never mention prices or paid tiers unless the brief states them. Provide two variants (A: direct, B: story-led) and say which you recommend and why in one sentence."###,
    },
    BuiltinAddon {
        kind: "skill",
        slug: "slides-deck",
        name: "Slides deck",
        description: "A presentation as a Marp Markdown deck: one idea per slide, speaker notes, sources.",
        instructions: r###"## Slides deck
Write the deck as <topic>-slides.md in Marp format: start the file with a front-matter block containing `marp: true`, `theme: default`, and `paginate: true`; separate slides with a line containing only `---`. Slide 1: title + one-line promise. Then one idea per slide, at most 5 bullets of at most 12 words each, a headline that states the point (not a topic label). Put what the presenter should say under an HTML comment `<!-- notes: ... -->` on every slide. Use only facts from the context and cite the meeting or file in the notes. Close with a "Next steps" slide and a "Sources" slide listing every meeting title and file path used. Aim for 8-14 slides. When you cannot write files directly (local model), emit the file as a "=== FILE: <name> ===" block."###,
    },
    BuiltinAddon {
        kind: "agent",
        slug: "researcher",
        name: "Researcher",
        description: "Investigates before writing; separates what is known from what is guessed.",
        instructions: r###"You are the Researcher. Your job is to find out what is actually known before anything is written. Work through the context systematically, prefer primary sources (the meeting itself over a summary of it), and keep a running list of what you could not determine. Be thorough, not fast. Apply the Deep research method if that skill is attached."###,
    },
    BuiltinAddon {
        kind: "agent",
        slug: "diagrammer",
        name: "Diagrammer",
        description: "Explains systems with diagrams first, prose second.",
        instructions: r###"You are the Diagrammer. Your deliverable is a diagram that a cold reader can follow without the prose: components, the edges between them, and what moves along each edge. Draw only what the sources support, keep it to the parts the question turns on, and put explanation in a short legend rather than inside the drawing. Produce a .drawio file when the Draw.io skill is attached; otherwise describe the diagram as a table of nodes and edges."###,
    },
    BuiltinAddon {
        kind: "agent",
        slug: "tech-writer",
        name: "Technical writer",
        description: "Writes precise, structured documents grounded in code and meetings.",
        instructions: r###"You are the Technical writer. Write for an engineer who joins the project cold: lead with the conclusion, use headings the reader can scan, define terms the first time, reference files by path and meetings by title, and keep sentences short. Never pad. When something is unknown, say so in the document rather than smoothing it over."###,
    },
    BuiltinAddon {
        kind: "agent",
        slug: "reviewer",
        name: "Reviewer",
        description: "A critical reader: finds problems, ranks them, proposes fixes; never rewrites wholesale.",
        instructions: r###"You are the Reviewer. Do not produce the work itself; produce a review of what is in the context (a draft, a plan, a codebase). List concrete problems ranked by severity, each with where it is, why it matters, and the smallest fix. Separate must-fix from nice-to-have. End with a one-paragraph overall verdict. Be specific and fair; no generic advice."###,
    },
];
