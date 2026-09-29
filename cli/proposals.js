#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { marked } from "marked";
import katex from "katex";
import { diffLines } from "diff";
import { createHighlighter } from "shiki";

const ROOT = resolve(process.env.PAPER_PROPOSALS_ROOT ?? ".agents/paperwork/proposals");
const DB_PATH = join(ROOT, "tracker.db");
const STATES = ["pending", "approved", "rejected", "rejected-with-comment", "rejected-complex-or-misformatted"];
const require = createRequire(import.meta.url);
const KATEX_CSS = readFileSync(require.resolve("katex/dist/katex.min.css"), "utf8");
const highlighter = await createHighlighter({
  themes: ["github-light"],
  langs: ["javascript", "typescript", "json", "bash", "shellscript", "rust", "python", "markdown", "yaml", "toml", "sql", "html", "css", "diff", "text"],
});

marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "text").split(/[ :]/)[0];
      if (language === "mermaid") return `<pre><code class="language-mermaid">${escapeHtml(text)}</code></pre>`;
      try { return highlighter.codeToHtml(text, { lang: highlighter.getLoadedLanguages().includes(language) ? language : "text", theme: "github-light" }); } catch { return `<pre><code>${escapeHtml(text)}</code></pre>`; }
    },
    codespan({ text }) {
      if (/^(?:[\w.-]+\/)*[\w.-]+\.(?:c|cc|cpp|css|go|h|html|java|js|json|jsx|md|py|rs|sh|sql|toml|ts|tsx|yml|yaml)$/.test(text)) {
        return `<a class="file-ref" href="/source?file=${encodeURIComponent(text)}" title="Open ${escapeHtml(text)} in source view"><code>${escapeHtml(text)}</code></a>`;
      }
      return `<code>${escapeHtml(text)}</code>`;
    },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const slug = text.replace(/<[^>]*>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clause";
      const id = `clause-${slug}`;
      return `<h${depth} id="${id}">${text} <a class="clause-link" href="#${id}" aria-label="Link to this clause" title="Copy or share this clause link">¶</a></h${depth}>`;
    },
  },
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start: (source) => source.indexOf("$$"),
      tokenizer(source) {
        const match = source.match(/^\$\$\n?([\s\S]*?)\n?\$\$(?:\n|$)/);
        return match ? { type: "mathBlock", raw: match[0], text: match[1].trim() } : undefined;
      },
      renderer(token) { return katex.renderToString(token.text, { displayMode: true, throwOnError: false }); },
    },
    {
      name: "mathInline",
      level: "inline",
      start: (source) => source.indexOf("$") ,
      tokenizer(source) {
        const match = source.match(/^\$([^$\n]+?)\$/);
        return match ? { type: "mathInline", raw: match[0], text: match[1] } : undefined;
      },
      renderer(token) { return katex.renderToString(token.text, { throwOnError: false }); },
    },
  ],
});

function die(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function usage() {
  console.error(`usage:
  proposals init
  proposals new TAG TITLE COMPONENT
  proposals submit TAG PROPOSAL.md
  proposals revision TAG PROPOSAL.md
  proposals review --human TAG STATE COMMENT
  proposals review --human TAG STATE COMMENT --revision NNN
  proposals message TAG ACTOR ACTION MESSAGE
  proposals status [TAG]
  proposals serve [PORT]`);
  process.exit(2);
}

function ensureSafeTag(tag) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) die(`unsafe tag: ${tag}`);
}

function ensureWorkspace() {
  mkdirSync(ROOT, { recursive: true });
  const db = new Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS proposals (
    tag TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    component TEXT NOT NULL,
    state TEXT NOT NULL,
    prerequisites TEXT NOT NULL DEFAULT '',
    parallel_group TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL,
    last_review_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS revisions (
    tag TEXT NOT NULL,
    revision TEXT NOT NULL,
    state TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    last_review_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(tag, revision)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS proposals_fts USING fts5(
    tag UNINDEXED,
    title,
    component,
    content,
    messages
  )`);
  normalizeSupersededRevisions(db);
  return db;
}

function normalizeSupersededRevisions(db) {
  const rows = db.query("SELECT tag, revision FROM revisions WHERE state = 'pending' ORDER BY tag, revision").all();
  const latestByTag = new Map();
  db.query("SELECT tag, MAX(revision) AS revision FROM revisions GROUP BY tag").all().forEach((row) => latestByTag.set(row.tag, row.revision));
  for (const row of rows) {
    if (row.revision === latestByTag.get(row.tag)) continue;
    writeFileSync(revisionStatePath(row.tag, row.revision), "superseded\n");
    db.query("UPDATE revisions SET state = 'superseded' WHERE tag = $tag AND revision = $revision").run({ $tag: row.tag, $revision: row.revision });
  }
}

function now() { return new Date().toISOString(); }
function dirFor(tag) { ensureSafeTag(tag); return join(ROOT, tag); }
function proposalPath(tag) { return join(dirFor(tag), "PROPOSAL.md"); }
function messagesPath(tag) { return join(dirFor(tag), "MESSAGES.md"); }
function statePath(tag) { return join(dirFor(tag), "state"); }
function revisionsDir(tag) { return join(dirFor(tag), "revisions"); }
function revisionPath(tag, revision) { return join(revisionsDir(tag), `${String(revision).padStart(3, "0")}.md`); }
function revisionStatePath(tag, revision) { return join(revisionsDir(tag), `${String(revision).padStart(3, "0")}.state`); }

function frontMatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  const result = {};
  for (const line of match?.[1]?.split("\n") ?? []) {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function pendingSubmission(markdown) {
  if (!/^---\n[\s\S]*?\n---/.test(markdown)) return markdown;
  if (/^status\s*:/m.test(markdown)) return markdown.replace(/^status\s*:.*/m, "status: pending");
  return markdown.replace(/^(---\n)/, "$1status: pending\n");
}

function proposalRecord(tag, db = ensureWorkspace()) {
  const row = db.query("SELECT * FROM proposals WHERE tag = $tag").get({ $tag: tag });
  if (!row) die(`unknown proposal: ${tag}`);
  return { ...row, markdown: readFileSync(proposalPath(tag), "utf8"), messages: readFileSync(messagesPath(tag), "utf8"), state: readFileSync(statePath(tag), "utf8").trim() };
}

function syncSearchIndex(db) {
  try {
    db.run("DELETE FROM proposals_fts");
    const rows = db.query("SELECT tag, title, component FROM proposals ORDER BY tag").all();
    for (const row of rows) {
      const proposal = readFileSync(proposalPath(row.tag), "utf8");
      const messages = readFileSync(messagesPath(row.tag), "utf8");
      const revisions = db.query("SELECT revision FROM revisions WHERE tag = $tag ORDER BY revision").all({ $tag: row.tag }).map(({ revision }) => readFileSync(revisionPath(row.tag, revision), "utf8")).join("\n");
      db.query("INSERT INTO proposals_fts(tag, title, component, content, messages) VALUES ($tag, $title, $component, $content, $messages)").run({ $tag: row.tag, $title: row.title, $component: row.component, $content: `${proposal}\n${revisions}`, $messages: messages });
    }
    return true;
  } catch {
    return false;
  }
}

function searchExpression(value) {
  return value.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function insertProposal(db, tag, title, component, submittedAt) {
  db.query(`INSERT INTO proposals(tag, title, component, state, submitted_at) VALUES ($tag, $title, $component, 'pending', $submittedAt)`).run({ $tag: tag, $title: title, $component: component, $submittedAt: submittedAt });
}

function newProposal([tag, title, component]) {
  if (!tag || !title || !component) usage();
  const db = ensureWorkspace();
  const dir = dirFor(tag);
  if (existsSync(dir)) die(`proposal already exists: ${dir}`);
  const submittedAt = now();
  mkdirSync(dir);
  writeFileSync(join(dir, "PROPOSAL.md"), `---
id: ${tag}
title: "${title.replaceAll('"', '\\"')}"
component: "${component.replaceAll('"', '\\"')}"
status: pending
submitted_at: ${submittedAt}
prerequisites: []
dependents: []
parallel_group: ""
---

# ${title}

## Problem and scope

### Problem

### Scope

### Non-goals

## Context and evidence

## Proposed design

## Interfaces and invariants

## Validation criteria

## Execution notes

## Risks, alternatives, and open decisions
`);
  writeFileSync(statePath(tag), "pending\n");
  writeFileSync(messagesPath(tag), "# Messages\n\n");
  insertProposal(db, tag, title, component, submittedAt);
  syncSearchIndex(db);
  console.log(dir);
}

function submitProposal([tag, source]) {
  if (!tag || !source) usage();
  ensureSafeTag(tag);
  if (!existsSync(source)) die(`proposal file not found: ${source}`);
  const markdown = readFileSync(source, "utf8");
  const fields = frontMatter(markdown);
  if (!fields.id) die("proposal must declare an id");
  const db = ensureWorkspace();
  const dir = dirFor(tag);
  if (existsSync(dir)) die(`proposal already exists: ${dir}`);
  const submittedAt = now();
  mkdirSync(dir);
  writeFileSync(proposalPath(tag), pendingSubmission(markdown));
  writeFileSync(statePath(tag), "pending\n");
  writeFileSync(messagesPath(tag), "# Messages\n\n");
  insertProposal(db, tag, fields.title ?? tag, fields.component ?? tag, submittedAt);
  syncSearchIndex(db);
  console.log(dir);
}

function nextRevision(tag) {
  mkdirSync(revisionsDir(tag), { recursive: true });
  const numbers = readdirSync(revisionsDir(tag), { withFileTypes: true }).map((entry) => Number(entry.name.match(/^(\d+)\.md$/)?.[1])).filter(Number.isFinite);
  return String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, "0");
}

function revisionProposal([tag, source]) {
  if (!tag || !source) usage();
  ensureSafeTag(tag);
  if (!existsSync(proposalPath(tag))) die(`unknown proposal: ${tag}`);
  if (!existsSync(source)) die(`revision file not found: ${source}`);
  const markdown = readFileSync(source, "utf8");
  const fields = frontMatter(markdown);
  const db = ensureWorkspace();
  const revision = nextRevision(tag);
  const submittedAt = now();
  db.query("SELECT revision FROM revisions WHERE tag = $tag AND state = 'pending'").all({ $tag: tag }).forEach(({ revision: oldRevision }) => {
    writeFileSync(revisionStatePath(tag, oldRevision), "superseded\n");
    db.query("UPDATE revisions SET state = 'superseded', last_review_at = $at WHERE tag = $tag AND revision = $revision").run({ $at: submittedAt, $tag: tag, $revision: oldRevision });
  });
  writeFileSync(revisionPath(tag, revision), pendingSubmission(markdown));
  writeFileSync(revisionStatePath(tag, revision), "pending\n");
  db.query("INSERT INTO revisions(tag, revision, state, submitted_at) VALUES ($tag, $revision, 'pending', $submittedAt)").run({ $tag: tag, $revision: revision, $submittedAt: submittedAt });
  db.query("UPDATE proposals SET state = 'pending', last_review_at = '' WHERE tag = $tag").run({ $tag: tag });
  appendFileSync(messagesPath(tag), `## ${submittedAt} — llm — revision ${revision}\n\nRevision submitted for human review from ${source}.\n\n`);
  syncSearchIndex(db);
  console.log(revisionPath(tag, revision));
}

function appendMessage(tag, actor, action, message) {
  if (!tag || !actor || !action || !message) usage();
  if (!(["llm", "human"].includes(actor))) die("actor must be llm or human");
  if (!existsSync(messagesPath(tag))) die(`unknown proposal: ${tag}`);
  appendFileSync(messagesPath(tag), `## ${now()} — ${actor} — ${action}\n\n${message}\n\n`);
  syncSearchIndex(ensureWorkspace());
}

function reviewProposal(args) {
  if (args[0] !== "--human" || args.length < 4) die("review requires --human TAG STATE COMMENT [--revision NNN]");
  const [, tag, state, comment, ...options] = args;
  if (!STATES.includes(state) || state === "pending") die(`invalid review state: ${state}`);
  if (!comment) die("review comment is required");
  const db = ensureWorkspace();
  const revisionIndex = options.length === 0 ? null : options.length === 2 && options[0] === "--revision" ? options[1] : die("invalid review options");
  if (revisionIndex !== null) {
    if (!existsSync(revisionPath(tag, revisionIndex))) die(`unknown revision: ${tag}/${revisionIndex}`);
    if (readFileSync(revisionStatePath(tag, revisionIndex), "utf8").trim() !== "pending") die("revision is not pending");
    const reviewedAt = now();
    writeFileSync(revisionStatePath(tag, revisionIndex), `${state}\n`);
    appendFileSync(messagesPath(tag), `## ${reviewedAt} — human — review revision ${revisionIndex}\n\nState: \`${state}\`\n\nComment:\n\n${comment}\n\n`);
    db.query("UPDATE revisions SET state = $state, last_review_at = $reviewedAt WHERE tag = $tag AND revision = $revision").run({ $state: state, $reviewedAt: reviewedAt, $tag: tag, $revision: revisionIndex });
    db.query("UPDATE proposals SET state = $state, last_review_at = $reviewedAt WHERE tag = $tag AND NOT EXISTS (SELECT 1 FROM revisions WHERE tag = $tag AND revision > $revision AND state != 'superseded')").run({ $state: state, $reviewedAt: reviewedAt, $tag: tag, $revision: revisionIndex });
    syncSearchIndex(db);
    return;
  }
  const record = proposalRecord(tag, db);
  if (record.state !== "pending") die("proposal is not pending");
  const reviewedAt = now();
  writeFileSync(statePath(tag), `${state}\n`);
  appendFileSync(messagesPath(tag), `## ${reviewedAt} — human — review\n\nState: \`${state}\`\n\nComment:\n\n${comment}\n\n`);
  db.query("UPDATE proposals SET state = $state, last_review_at = $reviewedAt WHERE tag = $tag").run({ $state: state, $reviewedAt: reviewedAt, $tag: tag });
  syncSearchIndex(db);
}

function status([tag]) {
  const db = ensureWorkspace();
  const rows = tag ? [proposalRecord(tag, db)] : db.query("SELECT * FROM proposals ORDER BY submitted_at").all().map((row) => proposalRecord(row.tag, db));
  console.table(rows.map((row) => ({ tag: row.tag, state: row.state, title: row.title, last_review_at: row.last_review_at })));
}

function proposalSnapshot(db) {
  return JSON.stringify(db.query("SELECT tag, state, last_review_at FROM proposals ORDER BY tag").all().map((row) => ({
    ...row,
    proposal_mtime: statSync(proposalPath(row.tag)).mtimeMs,
    messages_mtime: statSync(messagesPath(row.tag)).mtimeMs,
    state_file: readFileSync(statePath(row.tag), "utf8").trim(),
  })));
}

function sseEvent(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function metadataTable(row) {
  const metadata = { ...frontMatter(row.markdown), state: row.state, last_review_at: row.last_review_at || "" };
  const rows = Object.entries(metadata).map(([key, value]) => `<tr><th scope="row"><code>${escapeHtml(key)}</code></th><td>${escapeHtml(String(value))}</td></tr>`).join("");
  return `<table class="metadata"><thead><tr><th>frontmatter</th><th>value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function markdownBody(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function revisionRecords(db, tag) {
  return db.query("SELECT * FROM revisions WHERE tag = $tag ORDER BY revision").all({ $tag: tag }).map((row) => ({
    ...row,
    markdown: readFileSync(revisionPath(tag, row.revision), "utf8"),
    state: readFileSync(revisionStatePath(tag, row.revision), "utf8").trim(),
  }));
}

function unifiedDiff(before, after) {
  return diffLines(before, after).map((part) => {
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    return part.value.split("\n").map((line, index, lines) => index === lines.length - 1 && line === "" ? "" : `${prefix}${line}`).filter(Boolean).join("\n");
  }).filter(Boolean).join("\n") || "No textual changes.";
}

function documentHtml(markdown, tag) {
  const body = markdownBody(markdown).replace(/(\]\()((?:\.\/)?assets\/[^)\s]+)(\))/g, (_, prefix, href, suffix) => `${prefix}/proposal/${encodeURIComponent(tag)}/asset/${href.replace(/^\.\//, "").split("/").map(encodeURIComponent).join("/")}${suffix}`);
  return marked.parse(body);
}

function proposalAssetResponse(tag, encodedPath) {
  let relativePath;
  try { relativePath = decodeURIComponent(encodedPath); } catch { return new Response("Invalid asset path", { status: 400 }); }
  if (!relativePath || relativePath.split("/").includes("..") || relativePath.startsWith("/")) return new Response("Invalid asset path", { status: 400 });
  const base = resolve(dirFor(tag));
  const assetPath = resolve(base, relativePath);
  if (!assetPath.startsWith(`${base}/`) || !existsSync(assetPath)) return new Response("Asset not found", { status: 404 });
  const mime = { ".css": "text/css", ".gif": "image/gif", ".html": "text/html; charset=utf-8", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" }[extname(assetPath).toLowerCase()] ?? "application/octet-stream";
  return new Response(readFileSync(assetPath), { headers: { "content-type": mime, "cache-control": "no-cache" } });
}

function languageFor(name) {
  return ({ js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", yml: "yaml", md: "markdown" })[name.split(".").pop()] ?? name.split(".").pop() ?? "text";
}

function highlightedSource(source, name) {
  const language = languageFor(name);
  try { return highlighter.codeToHtml(source, { lang: highlighter.getLoadedLanguages().includes(language) ? language : "text", theme: "github-light" }); } catch { return `<pre><code>${escapeHtml(source)}</code></pre>`; }
}

function sourceView(db, tag, selectedRevision = null) {
  const row = proposalRecord(tag, db);
  const revisions = revisionRecords(db, tag);
  const revision = selectedRevision ? revisions.find((item) => item.revision === String(selectedRevision).padStart(3, "0")) : null;
  if (selectedRevision && !revision) die(`unknown revision: ${tag}/${selectedRevision}`);
  const source = revision?.markdown ?? row.markdown;
  const label = revision ? `revision r${revision.revision}` : "original submission";
  return page(`${row.title} source`, `<nav><a href="/proposal/${encodeURIComponent(tag)}">← Proposal</a></nav><main><header><h1>${escapeHtml(row.title)} <small>${escapeHtml(label)}</small></h1><p><a href="/proposal/${encodeURIComponent(tag)}${revision ? `/revision/${revision.revision}` : ""}/raw">raw Markdown</a></p></header><div class="sourceview">${highlightedSource(source, "proposal.md")}</div></main>`);
}

function gitSourceView(url) {
  const file = url.searchParams.get("file") ?? "";
  const ref = url.searchParams.get("ref") ?? "HEAD";
  if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").includes("..")) return new Response("Invalid source path", { status: 400 });
  const aliases = { ".agents/skills/paper-proposals/SKILL.md": "skills/propose/SKILL.md", "skills/paper-proposals/SKILL.md": "skills/propose/SKILL.md", ".agents/skills/paper-proposals/scripts/paper-proposals.js": "cli/paper-proposals.js" };
  const sourceFile = aliases[file] ?? file;
  const result = spawnSync("git", ["show", `${ref}:${sourceFile}`], { encoding: "utf8" });
  const source = result.status === 0 ? result.stdout : existsSync(resolve(sourceFile)) ? readFileSync(resolve(sourceFile), "utf8") : null;
  if (source === null) return new Response("Source not found", { status: 404 });
  const sourceLabel = result.status === 0 ? ref : "working tree";
  return new Response(page(`${file} · ${sourceLabel}`, `<nav><a href="/">← Proposal index</a></nav><main><header><h1>${escapeHtml(file)}</h1><p>Git ref: <code>${escapeHtml(sourceLabel)}</code>${sourceFile !== file ? ` · resolved to <code>${escapeHtml(sourceFile)}</code>` : ""}</p></header><div class="sourceview">${highlightedSource(source, sourceFile)}</div></main>`), { headers: { "content-type": "text/html; charset=utf-8" } });
}

const COMMENT_CSS = `.message-actions{position:relative;justify-content:flex-end}.toolbar-more,.review-menu-wrap{position:relative;display:inline-block}.toolbar-more summary{cursor:pointer;display:inline-block;border:1px solid #8c959f;border-radius:5px;padding:.55rem .8rem;font-size:.8rem;list-style:none}.toolbar-more summary::-webkit-details-marker{display:none}.floating-menu{position:absolute;z-index:4;min-width:14rem;padding:.35rem;background:#fff;border:1px solid #8c959f;border-radius:6px;box-shadow:0 8px 24px #24292f26}.floating-menu button{display:block;width:100%;margin:0;border:0;text-align:left}.more-menu{top:calc(100% + .4rem);left:0}.review-menu{right:0;bottom:calc(100% + .4rem)}.form-message{margin:.5rem 0;color:#cf222e;font-size:.9rem}button:focus-visible,summary:focus-visible{outline:2px solid #0969da;outline-offset:2px}@media(max-width:800px){.floating-menu{max-width:calc(100vw - 1.5rem);min-width:0}}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Proposals</title><style>
  :root{font:16px/1.55 ui-sans-serif,system-ui,sans-serif;color:#24292f;background:#f6f8fa}body{max-width:1220px;margin:0 auto;padding:2.5rem 1.25rem}a{color:#0969da}main{border-top:3px solid #24292f;padding-top:1.5rem}.grid{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(18rem,1fr);gap:3rem}.meta{font-size:.9rem;border-left:1px solid #d0d7de;padding-left:1.5rem}.metadata,.discovery{border-collapse:collapse;width:100%;font-size:.82rem}.metadata th,.metadata td,.discovery th,.discovery td{border-bottom:1px solid #d8dee4;padding:.45rem;text-align:left;vertical-align:top}.metadata th{white-space:nowrap}.discovery{font-size:.88rem}.discovery tbody.state-group>tr:first-child th{padding-top:1.3rem;text-transform:capitalize}.query{display:flex;gap:.5rem;margin:1rem 0}.query input,.query select{border:1px solid #8c959f;border-radius:5px;padding:.55rem}.status{font-weight:700}.pending{color:#9a6700}.approved{color:#1a7f37}.rejected,.rejected-with-comment,.rejected-complex-or-misformatted{color:#cf222e}textarea{width:100%;min-height:7rem;box-sizing:border-box}button{padding:.55rem .8rem;margin:.25rem;border:1px solid #8c959f;border-radius:5px;background:#fff;cursor:pointer}button:hover{background:#f3f4f6}form{margin-top:1.5rem}.thread{max-width:78ch;margin-top:3rem;border-top:2px solid #24292f;padding-top:1rem}.message{border-top:1px solid #d8dee4;padding:.75rem 0}.messagebox{border:1px solid #8c959f;background:#fff;padding:.75rem}.toolbar,.message-actions{display:flex;gap:.25rem;align-items:center;flex-wrap:wrap}.toolbar button{font-size:.8rem}.toolbar-more{display:inline-block}.toolbar-more summary{cursor:pointer;display:inline-block;border:1px solid #8c959f;border-radius:5px;padding:.55rem .8rem;font-size:.8rem;list-style:none}.toolbar-more summary::-webkit-details-marker{display:none}.toolbar-more[open]{background:#f3f4f6}.toolbar-more button{display:inline-block}.markdown-body{max-width:78ch;font-family:ui-serif,Georgia,serif;font-size:1.04rem}.markdown-body h1,.markdown-body h2,.markdown-body h3{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.2}.markdown-body img{max-width:100%}.markdown-body pre{overflow:auto;background:#f6f8fa;padding:1rem;border:1px solid #d8dee4}.markdown-body code{font-family:ui-monospace,SFMono-Regular,monospace;background:#f1f3f5;padding:.1rem .25rem;border-radius:3px}.diff{white-space:pre-wrap;font:0.8rem/1.5 ui-monospace,SFMono-Regular,monospace;background:#f6f8fa;border:1px solid #d8dee4;padding:1rem;overflow:auto}.sourceview{font:0.84rem/1.55 ui-monospace,SFMono-Regular,monospace;counter-reset:line}.sourceview .line{display:block}.sourceview .line::before{content:counter(line);counter-increment:line;display:inline-block;width:3.5em;margin-right:1em;color:#8c959f;text-align:right;user-select:none}.preview-popover{position:fixed;z-index:5;max-width:22rem;padding:.8rem;background:#fff;border:1px solid #8c959f;box-shadow:0 8px 24px #24292f26;font-size:.85rem}.revision-added{color:#1a7f37}.revision-removed{color:#cf222e}@media(max-width:800px){body{padding:1.25rem}.grid{grid-template-columns:1fr}.meta{border-left:0;border-top:1px solid #d0d7de;padding:1.25rem 0}.discovery{display:block;overflow-x:auto}}
  ${KATEX_CSS}${COMMENT_CSS}</style></head><body>${body}<script>
  (() => { const source = new EventSource("/events"); source.addEventListener("proposal-updated", () => setTimeout(() => location.reload(), 150));
    const blocks = [...document.querySelectorAll("pre code.language-mermaid")];
    if (blocks.length) import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(({default: mermaid}) => { blocks.forEach((block) => { const diagram = document.createElement("div"); diagram.className = "mermaid"; diagram.textContent = block.textContent; block.closest("pre").replaceWith(diagram); }); mermaid.initialize({startOnLoad:false,securityLevel:"strict"}); return mermaid.run(); }).catch(() => {});
    let preview;
    document.querySelectorAll("[data-preview]").forEach((link) => { link.addEventListener("mouseenter", async () => { preview?.remove(); preview = document.createElement("div"); preview.className = "preview-popover"; preview.textContent = "Loading preview…"; document.body.append(preview); const rect = link.getBoundingClientRect(); preview.style.left = Math.min(rect.left, innerWidth - 360) + "px"; preview.style.top = (rect.bottom + 8) + "px"; try { const html = await fetch(link.dataset.preview).then((response) => response.text()); const doc = new DOMParser().parseFromString(html, "text/html"); preview.innerHTML = "<strong>" + doc.title.replace(" · Proposals", "") + "</strong><br>" + (doc.querySelector(".markdown-body")?.innerText || doc.body.innerText).slice(0, 420); } catch { preview.textContent = "Preview unavailable"; } }); link.addEventListener("mouseleave", () => { setTimeout(() => preview?.remove(), 180); }); });
    const editor = document.getElementById("message-editor"); const previewPane = document.getElementById("message-preview");
    document.querySelectorAll("[data-markdown]").forEach((button) => button.addEventListener("click", () => { const [before, after] = button.dataset.markdown.split("|"); const start = editor.selectionStart; const end = editor.selectionEnd; const selected = editor.value.slice(start, end) || "text"; editor.setRangeText(before + selected + after, start, end, "select"); editor.focus(); }));
    const form = document.getElementById("message-form"); const reviewTrigger = document.getElementById("review-trigger"); const reviewMenu = document.getElementById("review-menu"); const validation = document.getElementById("review-validation"); const reviewItems = [...(reviewMenu?.querySelectorAll('[role="menuitem"]') ?? [])];
    const closeReviewMenu = (restoreFocus = false) => { if (!reviewMenu || !reviewTrigger) return; reviewMenu.hidden = true; reviewTrigger.setAttribute("aria-expanded", "false"); if (restoreFocus) reviewTrigger.focus(); };
    reviewTrigger?.addEventListener("click", () => { const opening = reviewMenu.hidden; reviewMenu.hidden = !opening; reviewTrigger.setAttribute("aria-expanded", String(opening)); if (opening) reviewItems[0]?.focus(); });
    reviewMenu?.addEventListener("keydown", (event) => { const index = reviewItems.indexOf(document.activeElement); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); reviewItems[(index + (event.key === "ArrowDown" ? 1 : -1) + reviewItems.length) % reviewItems.length]?.focus(); } else if (event.key === "Home") { event.preventDefault(); reviewItems[0]?.focus(); } else if (event.key === "End") { event.preventDefault(); reviewItems.at(-1)?.focus(); } else if (event.key === "Escape") { event.preventDefault(); closeReviewMenu(true); } });
    reviewItems.forEach((item) => item.addEventListener("click", () => { if (!editor?.reportValidity()) { if (validation) { validation.textContent = "Write a comment before choosing a review action."; validation.hidden = false; } closeReviewMenu(); return; } validation && (validation.hidden = true); form.querySelectorAll("input[data-review-field]").forEach((input) => input.remove()); const intent = document.createElement("input"); intent.type = "hidden"; intent.name = "intent"; intent.value = "review"; intent.dataset.reviewField = "true"; const state = document.createElement("input"); state.type = "hidden"; state.name = "state"; state.value = item.dataset.reviewState; state.dataset.reviewField = "true"; form.append(intent, state); closeReviewMenu(); form.requestSubmit(); }));
    document.addEventListener("click", (event) => { if (reviewMenu && reviewTrigger && !reviewMenu.contains(event.target) && !reviewTrigger.contains(event.target)) closeReviewMenu(); });
    document.querySelectorAll(".toolbar-more").forEach((details) => details.addEventListener("toggle", () => { if (details.open) closeReviewMenu(); }));
    document.getElementById("preview-toggle")?.addEventListener("click", async (event) => { event.preventDefault(); previewPane.hidden = !previewPane.hidden; editor.hidden = !previewPane.hidden; if (!previewPane.hidden) { const { marked: previewMarked } = await import("https://cdn.jsdelivr.net/npm/marked@15/+esm"); previewPane.innerHTML = previewMarked.parse(editor.value || "Nothing to preview."); } });
  })();
  </script></body></html>`;
}

function listValue(value) {
  return String(value ?? "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function paperLink(id, label = id) {
  return `<a class="paper-link" data-preview="/proposal/${encodeURIComponent(id)}" href="/proposal/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`;
}

function relationLinks(markdown, field) {
  return listValue(frontMatter(markdown)[field]).map((id) => paperLink(id)).join(", ") || "—";
}

function latestRevision(db, tag) {
  return db.query("SELECT revision, state, submitted_at, last_review_at FROM revisions WHERE tag = $tag ORDER BY revision DESC LIMIT 1").get({ $tag: tag });
}

function viewerIndex(db, url) {
  syncSearchIndex(db);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const requestedState = url.searchParams.get("state") ?? "";
  let rows = query ? db.query("SELECT p.* FROM proposals p JOIN proposals_fts f ON f.tag = p.tag WHERE proposals_fts MATCH $query ORDER BY p.submitted_at DESC").all({ $query: searchExpression(query) }) : db.query("SELECT * FROM proposals ORDER BY submitted_at DESC").all();
  rows = rows.map((row) => ({ ...row, latest: latestRevision(db, row.tag) }));
  if (requestedState) rows = rows.filter((row) => (row.latest?.state ?? row.state) === requestedState);
  const urgency = new Map([["pending", 0], ["rejected-with-comment", 1], ["rejected-complex-or-misformatted", 2], ["rejected", 3], ["approved", 4]]);
  const effectiveState = (row) => row.latest?.state ?? row.state;
  rows.sort((a, b) => (urgency.get(effectiveState(a)) ?? 9) - (urgency.get(effectiveState(b)) ?? 9) || (b.latest?.submitted_at ?? b.submitted_at).localeCompare(a.latest?.submitted_at ?? a.submitted_at));
  const groups = [...new Set(rows.map(effectiveState))].sort((a, b) => (urgency.get(a) ?? 9) - (urgency.get(b) ?? 9));
  const groupHtml = groups.map((state) => `<tbody class="state-group"><tr><th colspan="6"><span class="status ${state}">${escapeHtml(state)}</span> <small>${rows.filter((row) => effectiveState(row) === state).length}</small></th></tr>${rows.filter((row) => effectiveState(row) === state).map((row) => { const revision = row.latest; return `<tr><td><a class="paper-link" data-preview="/proposal/${encodeURIComponent(row.tag)}" href="/proposal/${encodeURIComponent(row.tag)}"><strong>${escapeHtml(row.title)}</strong></a><br><code>${escapeHtml(row.tag)}</code>${revision ? `<br><a href="/proposal/${encodeURIComponent(row.tag)}/revision/${encodeURIComponent(revision.revision)}">r${escapeHtml(revision.revision)} · ${escapeHtml(revision.state)}</a>` : ""}</td><td>${escapeHtml(row.component)}</td><td>${relationLinks(readFileSync(proposalPath(row.tag), "utf8"), "prerequisites")}</td><td>${relationLinks(readFileSync(proposalPath(row.tag), "utf8"), "dependents")}</td><td>${escapeHtml(revision?.last_review_at || revision?.submitted_at || row.last_review_at || row.submitted_at)}</td><td><a href="/source/${encodeURIComponent(row.tag)}">source</a></td></tr>`; }).join("")}</tbody>`).join("");
  const states = ["", ...STATES.filter((state) => state !== "pending")];
  return page("Proposal index", `<nav><a href="/">All proposals</a></nav><main><header><h1>Proposal index</h1><form class="query" method="get"><input name="q" value="${escapeHtml(query)}" placeholder="Search proposals" aria-label="Search proposals"><select name="state"><option value="">All states</option>${states.slice(1).map((state) => `<option ${requestedState === state ? "selected" : ""}>${escapeHtml(state)}</option>`).join("")}</select><button type="submit">Filter</button></form></header><table class="discovery"><thead><tr><th>Title</th><th>Component</th><th>Parents</th><th>Children</th><th>Reviewed / submitted</th><th>Source</th></tr></thead>${groupHtml || "<tbody><tr><td colspan=6>No matching proposals.</td></tr></tbody>"}</table></main>`);
}

function viewerProposal(db, tag, selectedRevision = null) {
  const row = proposalRecord(tag, db);
  const revisions = revisionRecords(db, tag);
  const revision = selectedRevision ? revisions.find((item) => item.revision === String(selectedRevision).padStart(3, "0")) : revisions.at(-1) ?? null;
  if (selectedRevision && !revision) die(`unknown revision: ${tag}/${selectedRevision}`);
  const markdown = revision?.markdown ?? row.markdown;
  const currentState = revision?.state ?? row.state;
  const messages = row.messages.replace(/^# Messages\s*/, "").trim();
  const messageHtml = messages ? marked.parse(messages) : "<p>No messages yet.</p>";
  const reviewFields = currentState === "pending" ? `<div class="review-menu-wrap"><button id="review-trigger" type="button" aria-haspopup="menu" aria-expanded="false">Review</button><div id="review-menu" class="floating-menu review-menu" role="menu" hidden><button type="button" role="menuitem" data-review-state="approved">Approve</button><button type="button" role="menuitem" data-review-state="rejected-with-comment">Reject with comment</button><button type="button" role="menuitem" data-review-state="rejected-complex-or-misformatted">Reject as complex or misformatted</button><button type="button" role="menuitem" data-review-state="rejected">Reject</button></div></div>` : "";
  const revisionField = revision ? `<input type="hidden" name="revision" value="${escapeHtml(revision.revision)}">` : "";
  const messageBox = `<form id="message-form" class="messagebox" method="post" action="/proposal/${encodeURIComponent(tag)}/message">${revisionField}<div class="toolbar"><button type="button" data-markdown="**|**">Bold</button><button type="button" data-markdown="*|*">Italic</button><details class="toolbar-more"><summary>More</summary><div class="floating-menu more-menu"><button type="button" data-markdown="> |">Quote</button><button type="button" data-markdown="\`|\`">Code</button><button type="button" data-markdown="[|](url)">Link</button><button type="button" id="preview-toggle">Preview</button></div></details></div><textarea id="message-editor" name="message" required placeholder="Write a comment in Markdown…"></textarea><div id="review-validation" class="form-message" role="alert" hidden></div><div id="message-preview" class="markdown-body" hidden></div><div class="message-actions"><button name="intent" value="comment" type="submit">Comment</button>${reviewFields}</div></form>`;
  const revisionLinks = revisions.length ? `<h3>Revisions</h3><ul>${revisions.map((item) => `<li><a href="/proposal/${encodeURIComponent(tag)}/revision/${item.revision}">r${item.revision}</a> <span class="status ${item.state}">${escapeHtml(item.state)}</span></li>`).join("")}</ul>` : "";
  const previousMarkdown = revision ? (revisions[revisions.findIndex((item) => item.revision === revision.revision) - 1]?.markdown ?? row.markdown) : null;
  const diffPanel = revision ? `<details><summary>Diff from previous revision</summary><pre class="diff">${escapeHtml(unifiedDiff(previousMarkdown, revision.markdown))}</pre></details>` : "";
  const rawLink = revision ? `/proposal/${encodeURIComponent(tag)}/revision/${revision.revision}/raw` : `/proposal/${encodeURIComponent(tag)}/raw`;
  const revisionLabel = revision ? `<p><strong>Revision:</strong> r${escapeHtml(revision.revision)} · <a href="${rawLink}">raw Markdown</a></p>` : `<p><a href="${rawLink}">raw Markdown</a></p>`;
  return page(row.title, `<nav><a href="/">← All proposals</a></nav><main><div class="grid"><article class="markdown-body">${documentHtml(markdown, tag)}${diffPanel}</article><aside class="meta"><h2>Metadata</h2>${metadataTable({...row, markdown, state: currentState})}${revisionLabel}${revisionLinks}</aside></div><section class="thread"><h2>Discussion</h2><div class="thread-messages">${messageHtml}</div>${messageBox}</section></main>`);
}

async function serve([portArg]) {
  const db = ensureWorkspace();
  const port = Number(portArg ?? process.env.PAPER_PROPOSALS_PORT ?? 3000);
  const clients = new Set();
  const history = [];
  let nextEventId = 0;
  let previousSnapshot = proposalSnapshot(db);
  const publish = (event, data) => {
    const item = { id: ++nextEventId, event, data };
    history.push(item);
    if (history.length > 100) history.shift();
    const encoded = sseEvent(item.id, item.event, item.data);
    for (const client of clients) {
      try { client.controller.enqueue(encoded); } catch { clients.delete(client); }
    }
  };
  const streamFor = (request) => {
    const lastEventHeader = request.headers.get("last-event-id");
    const parsedLastEventId = lastEventHeader === null ? null : Number(lastEventHeader);
    const lastEventId = parsedLastEventId !== null && Number.isInteger(parsedLastEventId) && parsedLastEventId >= 0 ? parsedLastEventId : null;
    let client;
    const stream = new ReadableStream({
      start(controller) {
        client = { controller, heartbeat: setInterval(() => controller.enqueue(`: alive ${Date.now()}\n\n`), 15000) };
        clients.add(client);
        controller.enqueue("retry: 1000\n\n");
        if (lastEventId !== null) {
          for (const item of history.filter(({ id }) => id > lastEventId)) controller.enqueue(sseEvent(item.id, item.event, item.data));
        }
        controller.enqueue(sseEvent(nextEventId, "hello", { alive: true, resumedFrom: lastEventId ?? nextEventId }));
      },
      cancel() {
        if (client) { clearInterval(client.heartbeat); clients.delete(client); }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
  };
  const watcher = setInterval(() => {
    const currentSnapshot = proposalSnapshot(db);
    if (currentSnapshot !== previousSnapshot) {
      previousSnapshot = currentSnapshot;
      publish("proposal-updated", { at: now() });
    }
  }, 1000);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const tagMatch = url.pathname.match(/^\/proposal\/([^/]+)$/);
      const revisionMatch = url.pathname.match(/^\/proposal\/([^/]+)\/revision\/([^/]+)$/);
      const rawMatch = url.pathname.match(/^\/proposal\/([^/]+)(?:\/revision\/([^/]+))?\/raw$/);
      const assetMatch = url.pathname.match(/^\/proposal\/([^/]+)\/asset\/(.+)$/);
      const sourceMatch = url.pathname.match(/^\/source\/([^/]+)(?:\/revision\/([^/]+))?$/);
      const actionMatch = url.pathname.match(/^\/proposal\/([^/]+)\/(review|message)$/);
      if (request.method === "GET" && url.pathname === "/events") return streamFor(request);
      if (request.method === "GET" && url.pathname === "/") return new Response(viewerIndex(db, url), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (request.method === "GET" && url.pathname === "/source") return gitSourceView(url);
      if (request.method === "GET" && sourceMatch) {
        try { return new Response(sourceView(db, decodeURIComponent(sourceMatch[1]), sourceMatch[2]), { headers: { "content-type": "text/html; charset=utf-8" } }); } catch (error) { return new Response(`<pre>${escapeHtml(String(error.message ?? error))}</pre>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }); }
      }
      if (request.method === "GET" && assetMatch) return proposalAssetResponse(decodeURIComponent(assetMatch[1]), assetMatch[2]);
      if (request.method === "GET" && rawMatch) {
        const tag = decodeURIComponent(rawMatch[1]);
        const markdown = rawMatch[2] ? revisionRecords(db, tag).find((item) => item.revision === rawMatch[2])?.markdown : proposalRecord(tag, db).markdown;
        if (!markdown) return new Response("Not found", { status: 404 });
        return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `inline; filename="${tag}${rawMatch[2] ? `-r${rawMatch[2]}` : ""}.md"` } });
      }
      if (request.method === "GET" && revisionMatch) {
        try { return new Response(viewerProposal(db, decodeURIComponent(revisionMatch[1]), revisionMatch[2]), { headers: { "content-type": "text/html; charset=utf-8" } }); } catch (error) { return new Response(`<pre>${escapeHtml(String(error.message ?? error))}</pre>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }); }
      }
      if (request.method === "GET" && tagMatch) {
        try { return new Response(viewerProposal(db, decodeURIComponent(tagMatch[1])), { headers: { "content-type": "text/html; charset=utf-8" } }); } catch (error) { return new Response(`<pre>${escapeHtml(String(error.message ?? error))}</pre>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }); }
      }
      if (request.method === "POST" && actionMatch) {
        const tag = decodeURIComponent(actionMatch[1]);
        const form = await request.formData();
        if (actionMatch[2] === "review") {
          const reviewArgs = ["--human", tag, String(form.get("state") ?? ""), String(form.get("comment") ?? "")];
          if (form.get("revision")) reviewArgs.push("--revision", String(form.get("revision")));
          reviewProposal(reviewArgs);
        }
        else if (form.get("intent") === "review") {
          const reviewArgs = ["--human", tag, String(form.get("state") ?? "approved"), String(form.get("message") ?? "")];
          if (form.get("revision")) reviewArgs.push("--revision", String(form.get("revision")));
          reviewProposal(reviewArgs);
        } else appendMessage(tag, "human", "discussion", String(form.get("message") ?? ""));
        return Response.redirect(new URL(`/proposal/${encodeURIComponent(tag)}`, request.url), 303);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.once("SIGINT", () => { clearInterval(watcher); server.stop(); });
  console.log(`Proposals viewer: http://${server.hostname}:${server.port}`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "init": ensureWorkspace().close(); break;
  case "new": newProposal(args); break;
  case "submit": submitProposal(args); break;
  case "revision": revisionProposal(args); break;
  case "review": reviewProposal(args); break;
  case "message": appendMessage(...args); break;
  case "status": status(args); break;
  case "serve": await serve(args); break;
  default: usage();
}
