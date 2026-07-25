# Adversaria Evaluation Corpus v1

The real corpus lives outside Git and is selected with
`ADVERSARIA_EVAL_CORPUS`. Only invented or redistributable fixtures belong in
this directory. The evaluator emits aggregate metrics and anonymized session
IDs; it never copies transcript, summary, claim, or action-item text into its
reports.

## Layout

```text
corpus-root/
  corpus.json
  session-a/
    session.json
    system.wav
    mic.wav
    reference.txt
    turns.json
    outcomes.json
    hypothesis.json
    reference.rttm        # optional
```

All paths in manifests are relative and may not escape their owning root.
`session_id` must be a stable anonymized identifier. `provenance` records
consent/source/license without putting a participant identity in the manifest.

`turns.json` contains `{id, speaker, text, start, end}` records. RTTM may be
retained for interoperability, while JSON turns are the deterministic scoring
contract. `outcomes.json` contains versioned IDs and text for names, entities,
dates, numbers, facts, decisions, and action items.

`hypothesis.json` pins the app version, model profile, every model revision, and
evaluation configuration. Summary claims and action items refer to reference
outcome IDs and evidence-turn IDs. This makes factual precision and action-item
traceability auditable instead of relying on an ungrounded judge score.

## Run

```bash
cd python-service
ADVERSARIA_EVAL_CORPUS=/private/path/to/corpus \
  uv run python -m eval.cli --output /private/path/to/reports/current \
  --baseline /private/path/to/reports/accepted/report.json --fail-on-gate
```

The synthetic CI smoke is:

```bash
uv run python -m eval.cli \
  --corpus eval/fixtures/synthetic \
  --output /tmp/adversaria-eval-smoke --fail-on-gate
```

The private release corpus must contain at least 20 sessions and five hours,
cover English, Arabic, code-switching, silence, playback bleed, noise, overlap,
long meetings, and two/three-speaker meetings. Reports are content-free, but
keep even aggregate private runs access-controlled until reviewed.
