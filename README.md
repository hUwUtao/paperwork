# paperwork

Paperwork is a small workflow for design proposals that deserve a written decision before implementation. It keeps proposal records immutable, routes them through human review, and provides a readable local viewer.

The intent is responsibility without turning every LLM step into a blocking approval ceremony.

## Install in an independent repository

The CLI requires [Bun](https://bun.sh/).

From this GitHub repository:

```sh
bun add --dev github:hUwUtao/paperwork
```

After the package is published, the registry form is:

```sh
bun add --dev proposals
```

The installed command is `proposals`. It stores data in the current repository at `.agents/paperwork/proposals`.

```sh
proposals init
proposals new example_component "Example component" "Example component"
proposals submit example_component ./PROPOSAL.md
proposals serve
```

Open the viewer at `http://127.0.0.1:3000`. Set `PAPER_PROPOSALS_ROOT` when the proposal workspace should live elsewhere.

## Install the skill

Install the skills.sh skill when an agent should write and submit proposals:

```sh
npx skills add hUwUtao/paperwork --skill propose
```

Invoke it as `$propose`. The skill defines RFC writing, submission, revision, and human feedback rules. The `proposals` package supplies the CLI and viewer.

## Local checkout

```sh
bun install
./proposals
```

The local wrapper is equivalent to the installed `proposals` command and roots the workspace in the repository where it is called.

## Review workflow

Create one proposal per design component:

```sh
proposals new <tag> "<title>" "<component>"
proposals verify <path/to/PROPOSAL.md>
proposals submit <tag> <path/to/PROPOSAL.md>
proposals status
proposals messages <tag>
proposals implemented <tag> [true|false]
```

Revisions are separate immutable records:

```sh
proposals verify <path/to/revised-proposal.md>
proposals revision <tag> <path/to/revised-proposal.md>
proposals serve
```

Use `proposals verify [TAG | PATH]` (or `proposals lint`) to verify that all referenced assets and source code files exist before submission.

Human review is recorded with an explanatory comment. Use `proposals messages <tag>` to inspect the full discussion before revising or implementing a plan. The viewer supports Markdown, syntax highlighting, Mermaid, LaTeX, revision diffs, full text search, source links, proposal relationships, and discussion threads.

Use the proposal front matter field `implementation_tags: []` for lightweight labels that group future implementation work. These labels are descriptive metadata only, not workflow state or a kanban board.

Mark implementation progress separately from review state:

```sh
proposals implemented <tag>       # defaults to true
proposals implemented <tag> false
```

## Current shape

Paperwork is intentionally compact. It is readable and useful for design incubation, but it is not presented as a complete audit system or a polished product suite. The viewer favors straightforward typography and server-rendered pages so the proposal itself stays easy to inspect.
