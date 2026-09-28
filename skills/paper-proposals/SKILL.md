---
name: paper-proposals
description: Write and submit formal RFC-style design proposals with explicit human review, immutable submissions, and tracked feedback.
metadata:
  short-description: Write and submit RFC design papers for human review
---

# Paper proposals

Use this skill for design incubation. Submit one paper for each component with its own approval boundary. Components may declare prerequisites, dependents, and a parallel group in front matter.

## Write the paper

Write `PROPOSAL.md` in Markdown using formal RFC language: precise, neutral, evidence-bounded, and explicit about decisions and uncertainty. Separate requirements, proposed behavior, assumptions, non-goals, alternatives, risks, and open questions. Do not present a proposal as shipped behavior. Do not embed proposal state or status within the proposal, while revisioning, avoid giving implementation or designing progress and always write a complete decision.

Begin with YAML front matter:

```yaml
---
id: <stable-id>
title: "<title>"
component: "<component>"
status: pending
submitted_at: <ISO-8601 timestamp>
prerequisites: []
dependents: []
parallel_group: ""
---
```

Include sections for problem and scope, context and evidence, proposed design, interfaces and invariants, validation criteria, execution notes, and risks/alternatives/open decisions. Mermaid or SVG diagrams, referenced images with reproducible provenance, LaTeX, and ordinary Markdown are allowed. Keep notation explained and the paper readable as plain text.

## Submit and track review

From the repository root, use the CLI:

```sh
./proposals new <tag> <title> <component>
./proposals submit <tag> <path/to/PROPOSAL.md>
./proposals status
```

Submission commands set the stored proposal or revision state to `pending` automatically; the input paper does not need to predeclare a review state.

Each paper is stored at `.agents/paperwork/proposals/<tag>/` with `PROPOSAL.md`, `MESSAGES.md`, and `state`; the shared index is `tracker.db`. Use a unique safe tag and never overwrite an existing paper.

The initial state is `pending`. Only human review may transition it to `approved`, `rejected`, `rejected-with-comment`, or `rejected-complex-or-misformatted`. A rejection requires an explanatory comment. Record discussion, human comments, and LLM responses in `MESSAGES.md`; retain human wording verbatim and label interpretations separately.

When a newer revision is submitted, older pending revisions are automatically marked `superseded`; this is an internal revision state, not a human review decision. The proposal thread follows the latest revision.

After approval, follow the accepted design and stage work according to its dependency graph. After rejection, respond in `MESSAGES.md` and resubmit the revision for review. Preserve the submitted paper as the review record.

## Do not

- Do not implement or claim implementation readiness before human approval.
- Do not silently rewrite a submitted `PROPOSAL.md`.
- Do not change `state` on the LLM’s own authority.
- Do not claim approval, validation, parallel safety, or external proof without evidence.
- Do not invent contracts, schemas, endpoints, assumptions, or dependencies unsupported by repository evidence.
- Do not hide unresolved decisions inside confident prose.
- Do not use ASCII art or ASCII wireframes; use prose, Markdown tables, Mermaid, or SVG instead.
- Do not place unwritable typographic symbols in proposal fine print. Use plain words and writable ASCII punctuation; write words such as "to", "through", "Review menu", or "three dots" instead of em dashes, arrows, triangles, ellipses, or similar glyphs.
- A graphical or visualization proposal MUST include a visual sample artifact, such as a raster image or other directly viewable sample. Markdown, HTML, Mermaid, or SVG alone is not sufficient.
- Do not impersonate a human in discussion or review records. LLM-authored entries MUST use the `llm` actor; only a human action may use the `human` actor.
- Describe visual sample provenance plainly and positively. Do not use defensive wording or contrast the sample with generation methods unless that detail is materially relevant.
