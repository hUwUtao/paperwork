---
id: 002_comment_box_review_actions
title: "Comment composer and review action menu"
component: "Proposal discussion and review controls"
status: pending
submitted_at: 2026-09-29T00:00:00.000Z
prerequisites: []
dependents: []
parallel_group: "proposal-viewer-ui"
---

# Comment composer and review action menu

## Problem and scope

The proposal viewer’s discussion composer currently places a native state `<select>` beside a submit button labelled `Approve ▾`. The label suggests that the current action is approval even when another state is selected. This makes the review action ambiguous at the point of submission.

The composer also gives secondary Markdown controls the same visual weight as the primary comment and review actions. The design requires a compact, keyboard-accessible composer with one explicit comment action and one proper review-action dropdown.

This decision covers the composer toolbar, review action menu, pending-state behavior, and the relationship between the active revision and its discussion thread. It does not change review permissions, proposal storage, Markdown syntax, or server-side state rules.

## Design decision

Use two clearly separated actions at the bottom of the composer:

```text
┌──────────────────────────────────────────────┐
│ Bold  Italic  More ▾                         │
│                                              │
│ Write a comment…                             │
│                                              │
│                                      Comment  │
│                                  Review ▾     │
└──────────────────────────────────────────────┘
```

`Comment` is a normal submit button for a discussion message. `Review ▾` is a real dropdown button, not a select styled as a button. Its closed label remains `Review ▾`, so it never falsely claims that approval is selected.

Opening `Review ▾` presents these actions:

1. `Approve`
2. `Reject with comment`
3. `Reject as complex or misformatted`
4. `Reject`

Choosing an action submits the existing review request with the corresponding state. Every review action requires the composer text as its explanatory comment. If the composer is empty, the menu action remains unavailable and the editor receives the validation message.

The review menu is available only while the active thread state is `pending`. For a non-pending thread, `Comment` remains available and the review menu is absent.

## Composer toolbar

Bold and Italic remain visible because they are the most frequent formatting actions. Quote, Code, Link, and Preview move under `More ▾`. `More ▾` is a disclosure control, not a submission control; opening it must not submit the form.

The editor remains Markdown-backed. Toolbar operations modify the selected text, and Preview renders the same Markdown that will be stored. The composer keeps the existing quoting and persistent-link conventions.

## Revision and thread behavior

The page represents one proposal thread. The latest revision is the active document and supplies the thread’s effective state. Older revisions remain addressable for history but cannot present an active review action after a newer revision is submitted.

The diff from the preceding revision remains available as an explicit disclosure and is collapsed by default. The latest revision’s review state is shown in metadata, the discovery row, and the action availability.

## Interaction and accessibility contract

The review control MUST:

- expose `aria-haspopup="menu"` and `aria-expanded`;
- open and close with mouse, Enter, and Space;
- support Arrow Up, Arrow Down, Home, End, and Escape while open;
- place focus on the first menu item when opened;
- return focus to the trigger after selection or Escape;
- close when focus leaves the menu or the user clicks outside; and
- provide visible focus styling without relying on color alone.

Each menu item MUST have an unambiguous accessible name and MUST submit exactly one review action. The closed trigger MUST NOT contain a state-specific label such as `Approve`.

The composer MUST remain usable without JavaScript for ordinary comments. JavaScript enhances the review menu and Markdown toolbar; the server remains responsible for validating the submitted state and comment.

## Visual language

Use the existing restrained proposal-viewer language: white message surface, thin neutral border, compact sans-serif controls, and serif reading content. The review menu may use a modest warning accent for rejection actions, but approval and rejection must remain distinguishable by text and iconography rather than color alone.

The menu should align to the review trigger, remain within the viewport on narrow screens, and not obscure the editor’s validation message. The primary actions should form one compact action row, with `Comment` first and `Review ▾` second.

## Invariants

1. A click on `Comment` creates a discussion message and does not change review state.
2. A review-menu action creates one human review event and requires a non-empty comment.
3. The displayed review state always belongs to the latest active revision.
4. A superseded revision cannot be reviewed from the active thread controls.
5. Closing or opening formatting disclosures does not submit the form.
6. The existing human-only review boundary remains unchanged.

## Validation criteria

The accepted design MUST demonstrate:

1. The closed review control reads `Review ▾`, never `Approve ▾`.
2. The four review actions are available from one keyboard-accessible menu.
3. Each action submits the correct state exactly once.
4. Empty review comments are rejected before submission and by the server boundary.
5. `Comment` remains distinct from review actions.
6. Older revisions show history only and cannot expose an active review action after a newer revision is submitted.
7. The latest revision controls the visible state and action availability on both the proposal page and discovery row.
8. The diff disclosure is collapsed on first render.
9. Secondary Markdown controls are hidden under `More ▾` while remaining keyboard reachable.
10. The interaction works at narrow viewport widths and with keyboard-only navigation.

## Execution boundary

This is one proposal-viewer UI decision. It has no prerequisite paper and MUST be reviewed before the composer or review-control implementation is changed.

## Risks and alternatives

A custom menu adds keyboard and focus-management obligations that a native select provides automatically. A native select was rejected because it separates the selected state from the action label and permits the misleading `Approve ▾` presentation. Separate visible buttons for all review outcomes were rejected because they increase visual noise and make rejection choices appear equivalent to ordinary commenting.
