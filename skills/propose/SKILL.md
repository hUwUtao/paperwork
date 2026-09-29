---
name: propose
description: Write and submit formal RFC-style design proposals with explicit human review, immutable submissions, and tracked feedback.
metadata:
  short-description: Write and submit RFC design papers for human review
---

# Proposals

Use this skill for design incubation. Submit one paper for each component with its own approval boundary. Components may declare prerequisites, dependents, a parallel group, and implementation tags in front matter.

## Write the paper

Write `PROPOSAL.md` in Markdown using formal RFC language: precise, neutral, evidence-bounded, and explicit about decisions and uncertainty. Treat the paper as an actionable plan for what will be done after approval, not only as a discovery report. Define the intended behavior, work boundaries, dependencies, execution order, validation, and unresolved decisions clearly enough that the accepted paper can guide implementation. Separate requirements, proposed behavior, assumptions, non-goals, alternatives, risks, and open questions. Do not present a proposal as shipped behavior. Do not embed proposal state or status within the proposal, while revisioning, avoid giving implementation or designing progress and always write a complete decision.

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
implementation_tags: []
---
```

Include sections for problem and scope, context and evidence, proposed design, interfaces and invariants, validation criteria, execution notes, and risks/alternatives/open decisions.

### Clause-level visual evidence

For each clause or section that explains behavior, structure, logic, space, or an implementation detail, include the clearest visual evidence when it improves understanding. Use more than one method when the clause needs it. Prefer the following methods by purpose:

- Mermaid for flows and logic.
- A fenced code snippet for flows, logic, implementation, shapes, or schemas. Use a meaningful language such as JSON, YAML, TypeScript, SQL, or Rust when one applies. Do not use plain text when a more precise language is available.
- An SVG image for shapes, spatial relationships, or rendered charts.
- An image for an asset or a preview.

Keep each visual next to the clause it explains, label its role, explain non-obvious notation, and include enough context for a reviewer to validate it. These are preferred methods, not a requirement to use only one method. Referenced images need reproducible provenance. LaTeX and ordinary Markdown are allowed. Keep notation explained and the paper readable as plain text.

Use `implementation_tags` for descriptive labels that help group future implementation work, such as `viewer`, `storage`, or `cli`. Tags do not represent approval state, priority, ownership, progress, or a kanban board. Change them through a revision so the submitted record remains immutable.

For code examples that need an in-place visual change marker, consider [Shiki's `transformerNotationDiff`](https://shiki.style/packages/transformers#transformernotationdiff). It can mark added and removed lines in a snippet with `[!code ++]` and `[!code --]`. It is useful for explaining a local code change inside a clause, but it is not a replacement for the proposal revision diff because it depends on source annotations, language comment syntax, and supporting CSS.

## Submit and track review

After installing the `proposals` package in the target repository, use the CLI from that repository:

```sh
proposals init
proposals new <tag> <title> <component>
proposals submit <tag> <path/to/PROPOSAL.md>
proposals status
proposals messages <tag>
proposals implemented <tag> [true|false]
proposals serve
```

The workspace defaults to `.agents/paperwork/proposals` under the current repository. `PAPER_PROPOSALS_ROOT` overrides that location. In this source checkout, `./proposals` is an equivalent local wrapper.

Submission commands set the stored proposal or revision state to `pending` automatically; the input paper does not need to predeclare a review state.

Each paper is stored at `.agents/paperwork/proposals/<tag>/` with `PROPOSAL.md`, `MESSAGES.md`, and `state`; the shared index is `tracker.db`. Use a unique safe tag and never overwrite an existing paper.

The initial state is `pending`. Only human review may transition it to `approved`, `rejected`, `rejected-with-comment`, or `rejected-complex-or-misformatted`. A rejection requires an explanatory comment. Record discussion, human comments, and LLM responses in `MESSAGES.md`; retain human wording verbatim and label interpretations separately.

Actively assess the message board before drafting, revising, or following an approved plan. Read `proposals messages <tag>` and resolve each applicable comment in the next paper or response. Use `proposals message <tag> llm <action> <message>` to record an LLM response, and keep the response tied to the human comment it addresses. Do not treat a proposal as ready merely because its state changed; inspect the discussion and current revision.

Track implementation separately with `proposals implemented <tag> [true|false]`. The value defaults to `true`; it changes implementation tracking only and does not approve, reject, revise, or alter the proposal.

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
