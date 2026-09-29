#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { marked } from "marked";

export const DEFAULT_SOURCE_ALIASES = {
  ".agents/skills/paper-proposals/SKILL.md": "skills/propose/SKILL.md",
  "skills/paper-proposals/SKILL.md": "skills/propose/SKILL.md",
  ".agents/skills/paper-proposals/scripts/paper-proposals.js": "cli/proposals.js",
  "cli/paper-proposals.js": "cli/proposals.js",
};

export const SOURCE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cxx", "h", "hpp", "rs", "go", "py", "rb", "php",
  "java", "kt", "kts", "scala", "cs", "swift", "js", "mjs", "cjs", "jsx",
  "ts", "mts", "cts", "tsx", "sh", "bash", "zsh", "fish", "sql", "html",
  "css", "scss", "sass", "less", "json", "jsonc", "json5", "yaml", "yml",
  "toml", "xml", "md"
]);

export const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff",
  "avif", "mp4", "webm", "ogv", "mp3", "wav", "ogg", "pdf"
]);

export const CODESPAN_SOURCE_PATTERN = /^(?:(?:\.{1,2}|[\w.-]+)\/)*[\w.-]+\.(?:c|cc|cpp|cxx|h|hpp|rs|go|py|rb|php|java|kt|kts|scala|cs|swift|js|mjs|cjs|jsx|ts|mts|cts|tsx|sh|bash|zsh|fish|sql|html|css|scss|sass|less|json|jsonc|json5|yaml|yml|toml|xml|md)(?:(?::\d+(?:[-–]\d+)?)|(?:#(?:L|line-?)?\d+(?:[-–](?:L|line-?)?\d+)?))?(?:\?[A-Za-z0-9._&=-]+)?(?:#(?:L|line-?)?\d+(?:[-–](?:L|line-?)?\d+)?)?$/i;

export function isExternalUrl(url) {
  if (!url || typeof url !== "string") return true;
  const trimmed = url.trim();
  return (
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    /^https?:\/\//i.test(trimmed) ||
    /^(?:mailto|tel|data|blob|javascript):/i.test(trimmed)
  );
}

export function parseCodeReference(target) {
  if (!target || typeof target !== "string") return null;
  let str = target.trim();
  if (str.startsWith("file://")) {
    str = str.replace(/^file:\/\//, "");
  }

  let commit = null;
  let startLine = null;
  let endLine = null;

  // Extract commit from query string (before or after #)
  const commitMatch = str.match(/[?&](?:commit|ref)=([A-Za-z0-9._-]+)/i);
  if (commitMatch) {
    commit = commitMatch[1];
  }

  // Strip query string from path parts for line matching
  const withoutQuery = str.replace(/\?[^#]*/, "");

  // Extract line range from hash (#L10-L20, #L10-20, #L10) or colon (:10-20, :10, :10:5)
  const hashMatch = withoutQuery.match(/#(?:L|line-?)?(\d+)(?:[-–](?:L|line-?)?(\d+))?/i);
  const colonMatch = !hashMatch ? withoutQuery.match(/:(\d+)(?::\d+)?(?:[-–](\d+))?$/) : null;

  if (hashMatch) {
    startLine = parseInt(hashMatch[1], 10);
    endLine = hashMatch[2] ? parseInt(hashMatch[2], 10) : startLine;
  } else if (colonMatch) {
    startLine = parseInt(colonMatch[1], 10);
    endLine = colonMatch[2] ? parseInt(colonMatch[2], 10) : startLine;
  }

  // Clean path: strip query params, hash fragments, line colons
  let filePath = str
    .replace(/[?&].*$/, "")
    .replace(/#.*$/, "")
    .replace(/:\d+(?::\d+)?(?:[-–]\d+)?$/, "");

  try {
    filePath = decodeURIComponent(filePath);
  } catch {}

  return { filePath, startLine, endLine, commit };
}

export function cleanTarget(url) {
  if (!url) return "";
  let pathOnly = url.trim().replace(/^file:\/\//, "");
  pathOnly = pathOnly.split(/[?#]/)[0];
  pathOnly = pathOnly.replace(/:\d+(?::\d+)?(?:[-–]\d+)?$/, "");
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return pathOnly;
  }
}

function findRepoRoot(startDir = process.cwd()) {
  try {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: startDir, encoding: "utf8" });
    if (git.status === 0 && git.stdout.trim()) {
      return git.stdout.trim();
    }
  } catch {}
  return resolve(startDir);
}

export function extractReferences(markdown) {
  const tokens = marked.lexer(markdown);
  const references = [];
  let blockOffset = 0;

  function parseHtmlTags(html, baseLine, startOffset) {
    const mediaTagRegex = /<(?:img|video|audio|embed)\b([^>]*?)>/gi;
    let match;
    while ((match = mediaTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (srcMatch) {
        const offset = startOffset + match.index + match[0].indexOf(srcMatch[1]);
        const line = markdown.slice(0, offset).split("\n").length;
        references.push({
          category: "asset",
          kind: "html-media",
          raw: match[0],
          target: srcMatch[1],
          line,
        });
      }
    }

    const sourceTagRegex = /<source\b([^>]*?)>/gi;
    while ((match = sourceTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const srcsetMatch = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (srcsetMatch) {
        const candidates = srcsetMatch[1].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
        for (const candidate of candidates) {
          const offset = startOffset + match.index + match[0].indexOf(candidate);
          const line = markdown.slice(0, offset).split("\n").length;
          references.push({
            category: "asset",
            kind: "html-source",
            raw: match[0],
            target: candidate,
            line,
          });
        }
      }
    }

    const objectTagRegex = /<object\b([^>]*?)>/gi;
    while ((match = objectTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const dataMatch = /\bdata\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (dataMatch) {
        const offset = startOffset + match.index + match[0].indexOf(dataMatch[1]);
        const line = markdown.slice(0, offset).split("\n").length;
        references.push({
          category: "asset",
          kind: "html-object",
          raw: match[0],
          target: dataMatch[1],
          line,
        });
      }
    }

    const anchorTagRegex = /<a\b([^>]*?)>/gi;
    while ((match = anchorTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (hrefMatch && !isExternalUrl(hrefMatch[1])) {
        const target = hrefMatch[1];
        const clean = cleanTarget(target);
        const ext = clean.split(".").pop()?.toLowerCase();
        const offset = startOffset + match.index + match[0].indexOf(target);
        const line = markdown.slice(0, offset).split("\n").length;
        if (ASSET_EXTENSIONS.has(ext) || clean.includes("assets/")) {
          references.push({
            category: "asset",
            kind: "html-link",
            raw: match[0],
            target,
            line,
          });
        } else if (SOURCE_EXTENSIONS.has(ext) || clean.includes("/")) {
          references.push({
            category: "source",
            kind: "html-link",
            raw: match[0],
            target,
            line,
          });
        }
      }
    }
  }

  function walk(toks, parentOffset) {
    let inlineOffset = 0;
    for (const token of toks) {
      const raw = token.raw ?? "";
      let tokenOffset = parentOffset + inlineOffset;
      if (raw) {
        const found = markdown.indexOf(raw, parentOffset + inlineOffset);
        if (found !== -1) {
          tokenOffset = found;
          inlineOffset = (found - parentOffset) + raw.length;
        }
      }

      const line = markdown.slice(0, tokenOffset).split("\n").length;

      if (token.type === "image") {
        references.push({
          category: "asset",
          kind: "markdown-image",
          raw,
          target: token.href,
          text: token.text,
          line,
        });
      } else if (token.type === "link") {
        if (!isExternalUrl(token.href)) {
          const clean = cleanTarget(token.href);
          const ext = clean.split(".").pop()?.toLowerCase();
          if (ASSET_EXTENSIONS.has(ext) || clean.includes("assets/")) {
            references.push({
              category: "asset",
              kind: "markdown-link",
              raw,
              target: token.href,
              text: token.text,
              line,
            });
          } else if (SOURCE_EXTENSIONS.has(ext) || clean.includes("/")) {
            references.push({
              category: "source",
              kind: "markdown-link",
              raw,
              target: token.href,
              text: token.text,
              line,
            });
          }
        }
      } else if (token.type === "codespan") {
        const text = (token.text ?? "").trim();
        if (
          CODESPAN_SOURCE_PATTERN.test(text) &&
          !/[<>${}[\]\s]/.test(text)
        ) {
          references.push({
            category: "source",
            kind: "codespan",
            raw,
            target: text,
            line,
          });
        }
      } else if (token.type === "html") {
        parseHtmlTags(token.text ?? raw, line, tokenOffset);
      }

      if (token.tokens) walk(token.tokens, tokenOffset);
      if (token.items) {
        for (const item of token.items) {
          const itemOffset = markdown.indexOf(item.raw ?? "", tokenOffset);
          if (item.tokens) walk(item.tokens, itemOffset !== -1 ? itemOffset : tokenOffset);
        }
      }
      if (token.header) {
        for (const cell of token.header) {
          const cellOffset = markdown.indexOf(cell.raw ?? cell.text ?? "", tokenOffset);
          if (cell.tokens) walk(cell.tokens, cellOffset !== -1 ? cellOffset : tokenOffset);
        }
      }
      if (token.rows) {
        for (const row of token.rows) {
          for (const cell of row) {
            const cellOffset = markdown.indexOf(cell.raw ?? cell.text ?? "", tokenOffset);
            if (cell.tokens) walk(cell.tokens, cellOffset !== -1 ? cellOffset : tokenOffset);
          }
        }
      }
    }
  }

  for (const block of tokens) {
    const raw = block.raw ?? "";
    const found = markdown.indexOf(raw, blockOffset);
    const start = found !== -1 ? found : blockOffset;
    blockOffset = start + raw.length;

    if (block.tokens) {
      walk(block.tokens, start);
    } else if (block.type === "html") {
      const line = markdown.slice(0, start).split("\n").length;
      parseHtmlTags(block.text ?? raw, line, start);
    }
    if (block.items) {
      for (const item of block.items) {
        const itemOffset = markdown.indexOf(item.raw ?? "", start);
        if (item.tokens) walk(item.tokens, itemOffset !== -1 ? itemOffset : start);
      }
    }
    if (block.header) {
      for (const cell of block.header) {
        const cellOffset = markdown.indexOf(cell.raw ?? cell.text ?? "", start);
        if (cell.tokens) walk(cell.tokens, cellOffset !== -1 ? cellOffset : start);
      }
    }
    if (block.rows) {
      for (const row of block.rows) {
        for (const cell of row) {
          const cellOffset = markdown.indexOf(cell.raw ?? cell.text ?? "", start);
          if (cell.tokens) walk(cell.tokens, cellOffset !== -1 ? cellOffset : start);
        }
      }
    }
  }

  return references;
}

export function resolveAssetPath(target, markdownPath, repoRoot) {
  if (isExternalUrl(target)) {
    return { exists: true, external: true, resolvedPath: null };
  }
  const clean = cleanTarget(target);
  if (!clean) {
    return { exists: false, resolvedPath: null };
  }

  const markdownDir = markdownPath ? dirname(resolve(markdownPath)) : process.cwd();
  const root = repoRoot ?? findRepoRoot(markdownDir);

  const candidates = [];

  // 1. Within proposal directory
  candidates.push(resolve(markdownDir, clean));
  if (basename(markdownDir) === "revisions") {
    candidates.push(resolve(markdownDir, "..", clean));
  }
  candidates.push(resolve(markdownDir, "assets", clean));
  if (basename(markdownDir) === "revisions") {
    candidates.push(resolve(markdownDir, "..", "assets", clean));
  }

  // 2. By coderef (project root)
  if (clean.startsWith("/")) {
    candidates.push(resolve(root, clean.replace(/^\/+/, "")));
  } else {
    candidates.push(resolve(root, clean));
  }
  candidates.push(resolve(root, "assets", clean));

  // 3. By node_modules
  candidates.push(resolve(root, "node_modules", clean));
  candidates.push(resolve(markdownDir, "node_modules", clean));
  if (clean.startsWith("node_modules/")) {
    candidates.push(resolve(root, clean));
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        if (statSync(c).isFile()) {
          return { exists: true, resolvedPath: c };
        }
      } catch {}
    }
  }

  return { exists: false, resolvedPath: candidates[0] };
}

export function resolveSourcePath(target, markdownPath, repoRoot, aliases = DEFAULT_SOURCE_ALIASES, options = {}) {
  if (isExternalUrl(target)) {
    return { exists: true, external: true, resolvedPath: null };
  }

  const parsed = parseCodeReference(target);
  if (!parsed || !parsed.filePath) {
    return { exists: false, resolvedPath: null, error: `Invalid code reference: "${target}"` };
  }

  const { filePath, startLine, endLine, commit } = parsed;
  const markdownDir = markdownPath ? dirname(resolve(markdownPath)) : process.cwd();
  const root = repoRoot ?? findRepoRoot(markdownDir);

  const aliased = aliases?.[filePath] ?? filePath;
  const cleanGitPath = (aliased.startsWith("/") ? aliased.slice(1) : aliased).replace(/^\.\//, "");

  let content = null;
  let resolvedPath = null;
  let fromGit = false;

  // Code references must match by project root
  if (commit) {
    // Verify commit exists in git
    const commitCheck = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: root });
    if (commitCheck.status !== 0) {
      return {
        exists: false,
        resolvedPath: null,
        error: `Git commit "${commit}" does not exist for "${target}"`,
      };
    }

    // Verify file exists at that commit
    const catCheck = spawnSync("git", ["cat-file", "-e", `${commit}:${cleanGitPath}`], { cwd: root });
    if (catCheck.status !== 0) {
      return {
        exists: false,
        resolvedPath: `git:${commit}:${cleanGitPath}`,
        error: `File "${filePath}" does not exist at commit "${commit}"`,
      };
    }

    const showResult = spawnSync("git", ["show", `${commit}:${cleanGitPath}`], { cwd: root, encoding: "utf8" });
    content = showResult.stdout;
    resolvedPath = `git:${commit}:${cleanGitPath}`;
    fromGit = true;
  } else {
    // Match by project root in working tree
    const rootCandidates = [
      resolve(root, filePath),
      resolve(root, aliased),
      resolve(root, filePath.replace(/^\/+/, "")),
      resolve(markdownDir, filePath),
    ];

    for (const c of rootCandidates) {
      if (existsSync(c)) {
        try {
          const st = statSync(c);
          if (st.isFile()) {
            resolvedPath = c;
            content = readFileSync(c, "utf8");
            break;
          } else if (st.isDirectory()) {
            return { exists: true, resolvedPath: c, isDirectory: true };
          }
        } catch {}
      }
    }

    // Fallback to git HEAD if git available
    if (content === null && options.gitFallback !== false) {
      const catCheck = spawnSync("git", ["cat-file", "-e", `HEAD:${cleanGitPath}`], { cwd: root });
      if (catCheck.status === 0) {
        const showResult = spawnSync("git", ["show", `HEAD:${cleanGitPath}`], { cwd: root, encoding: "utf8" });
        content = showResult.stdout;
        resolvedPath = `git:HEAD:${cleanGitPath}`;
        fromGit = true;
      } else {
        const logCheck = spawnSync("git", ["log", "-1", "--", cleanGitPath], { cwd: root, encoding: "utf8" });
        if (logCheck.status === 0 && logCheck.stdout.trim().length > 0) {
          resolvedPath = `git:history:${cleanGitPath}`;
          fromGit = true;
          // Retrieve content from historical commit
          const histShow = spawnSync("git", ["show", `HEAD~1:${cleanGitPath}`], { cwd: root, encoding: "utf8" });
          content = histShow.status === 0 ? histShow.stdout : "";
        }
      }
    }
  }

  if (resolvedPath === null) {
    return {
      exists: false,
      resolvedPath: resolve(root, filePath),
      error: `Referenced source code does not exist from project root: "${filePath}"`,
    };
  }

  // Validate perma static line range #L<LINE>[-LINE]
  if (content !== null && startLine !== null) {
    if (startLine < 1) {
      return {
        exists: false,
        resolvedPath,
        error: `Invalid line number L${startLine} in "${target}" (must be >= 1)`,
      };
    }
    if (endLine !== null && endLine < startLine) {
      return {
        exists: false,
        resolvedPath,
        error: `Invalid line range L${startLine}-L${endLine} in "${target}" (end line cannot be before start line)`,
      };
    }

    const lines = content.split("\n");
    const totalLines = lines.length;

    if (startLine > totalLines) {
      return {
        exists: false,
        resolvedPath,
        startLine,
        endLine,
        totalLines,
        error: `Referenced line L${startLine} exceeds total line count (${totalLines}) of "${filePath}"`,
      };
    }

    if (endLine !== null && endLine > totalLines) {
      return {
        exists: false,
        resolvedPath,
        startLine,
        endLine,
        totalLines,
        error: `Referenced line range end L${endLine} exceeds total line count (${totalLines}) of "${filePath}"`,
      };
    }
  }

  return {
    exists: true,
    resolvedPath,
    fromGit,
    startLine,
    endLine,
    commit,
  };
}

export function verifyMarkdown(markdown, options = {}) {
  const {
    filePath = null,
    repoRoot = findRepoRoot(filePath ? dirname(resolve(filePath)) : process.cwd()),
    aliases = DEFAULT_SOURCE_ALIASES,
    ignoreNames = [],
    gitFallback = true,
  } = options;

  const references = extractReferences(markdown);
  const errors = [];
  const checkedReferences = [];
  const ignoredSet = new Set(ignoreNames);

  for (const ref of references) {
    const clean = cleanTarget(ref.target);

    if (ref.category === "asset") {
      if (isExternalUrl(ref.target)) continue;
      const res = resolveAssetPath(ref.target, filePath, repoRoot);
      const item = { ...ref, exists: res.exists, resolvedPath: res.resolvedPath };
      checkedReferences.push(item);
      if (!res.exists) {
        errors.push({
          file: filePath,
          line: ref.line,
          category: "missing-asset",
          target: ref.target,
          resolvedPath: res.resolvedPath,
          message: res.error || `Asset file does not exist: "${ref.target}"`,
        });
      }
    } else if (ref.category === "source") {
      if (isExternalUrl(ref.target)) continue;
      if (ignoredSet.has(clean) || ignoredSet.has(basename(clean))) continue;

      const res = resolveSourcePath(ref.target, filePath, repoRoot, aliases, { gitFallback });
      const item = { ...ref, exists: res.exists, resolvedPath: res.resolvedPath, fromGit: res.fromGit, startLine: res.startLine, endLine: res.endLine, commit: res.commit };
      checkedReferences.push(item);
      if (!res.exists) {
        errors.push({
          file: filePath,
          line: ref.line,
          category: "missing-source",
          target: ref.target,
          resolvedPath: res.resolvedPath,
          message: res.error || `Referenced source code does not exist: "${ref.target}"`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    references: checkedReferences,
  };
}

export function verifyFile(filePath, options = {}) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    return {
      valid: false,
      file: filePath,
      errors: [{
        file: filePath,
        line: 1,
        category: "file-not-found",
        target: filePath,
        message: `File not found: ${filePath}`,
      }],
      references: [],
    };
  }

  const content = readFileSync(fullPath, "utf8");
  const result = verifyMarkdown(content, { ...options, filePath: fullPath });
  return {
    ...result,
    file: filePath,
  };
}

export function verifyProposal(tag, options = {}) {
  const proposalsRoot = resolve(options.proposalsRoot ?? process.env.PAPER_PROPOSALS_ROOT ?? ".agents/paperwork/proposals");
  const proposalDir = join(proposalsRoot, tag);

  if (!existsSync(proposalDir)) {
    return {
      valid: false,
      tag,
      files: [],
      errors: [{
        file: proposalDir,
        line: 1,
        category: "proposal-not-found",
        target: tag,
        message: `Proposal not found: ${tag}`,
      }],
    };
  }

  const filesToCheck = [];
  const mainProposal = join(proposalDir, "PROPOSAL.md");
  if (existsSync(mainProposal)) {
    filesToCheck.push(mainProposal);
  }

  const revisionsDir = join(proposalDir, "revisions");
  if (existsSync(revisionsDir)) {
    try {
      const revs = readdirSync(revisionsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const rev of revs) {
        filesToCheck.push(join(revisionsDir, rev));
      }
    } catch {}
  }

  const fileResults = [];
  const errors = [];
  for (const file of filesToCheck) {
    const res = verifyFile(file, options);
    fileResults.push(res);
    errors.push(...res.errors);
  }

  return {
    valid: errors.length === 0,
    tag,
    files: fileResults,
    errors,
  };
}

export function verifyWorkspace(options = {}) {
  const proposalsRoot = resolve(options.proposalsRoot ?? process.env.PAPER_PROPOSALS_ROOT ?? ".agents/paperwork/proposals");
  if (!existsSync(proposalsRoot)) {
    return {
      valid: true,
      proposals: [],
      totalFiles: 0,
      totalErrors: 0,
      errors: [],
    };
  }

  const tags = [];
  try {
    const entries = readdirSync(proposalsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(proposalsRoot, entry.name, "PROPOSAL.md"))) {
        tags.push(entry.name);
      }
    }
  } catch {}

  const proposals = [];
  const allErrors = [];
  let totalFiles = 0;

  for (const tag of tags.sort()) {
    const res = verifyProposal(tag, options);
    proposals.push(res);
    totalFiles += res.files.length;
    allErrors.push(...res.errors);
  }

  return {
    valid: allErrors.length === 0,
    proposals,
    totalProposals: proposals.length,
    totalFiles,
    totalErrors: allErrors.length,
    errors: allErrors,
  };
}

export function formatReport(results) {
  const lines = [];
  const files = Array.isArray(results) ? results : results.files ? results.files : results.proposals ? results.proposals.flatMap((p) => p.files) : [results];

  let totalErrors = 0;
  let totalReferences = 0;

  for (const fileResult of files) {
    const relFile = fileResult.file;
    const errors = fileResult.errors ?? [];
    totalErrors += errors.length;
    totalReferences += (fileResult.references ?? []).length;

    if (errors.length === 0) {
      lines.push(`✔ ${relFile} (${fileResult.references?.length ?? 0} references verified)`);
    } else {
      lines.push(`✖ ${relFile}:`);
      for (const err of errors) {
        lines.push(`    Line ${err.line}: [${err.category}] ${err.message}`);
        if (err.resolvedPath) {
          lines.push(`      Checked path: ${err.resolvedPath}`);
        }
      }
    }
  }

  lines.push("");
  if (totalErrors === 0) {
    lines.push(`Passed: ${files.length} file(s) checked, 0 errors, ${totalReferences} reference(s) verified.`);
  } else {
    lines.push(`Failed: ${files.length} file(s) checked, ${totalErrors} error(s) found.`);
  }

  return lines.join("\n");
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  let jsonOutput = false;
  let quiet = false;
  let proposalsRoot = null;
  const targets = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg === "--proposals-root") {
      proposalsRoot = args.shift();
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Markdown Verify Linter

Usage:
  proposals verify [TAG | PATH]
  bun cli/verify.js [options] [TAG | PATH ...]

Options:
  --proposals-root <dir>  Override proposals directory
  --json                  Output JSON report
  --quiet, -q             Only print when errors are found
  -h, --help              Show this help message

Verification:
  - Verifies asset existence (within proposal, by coderef, or by node_modules)
  - Verifies referenced source code existence (must match by project root, allows perma static line #L<LINE>[-LINE][?commit=HASH])
`);
      return 0;
    } else {
      targets.push(arg);
    }
  }

  const options = { proposalsRoot };

  if (targets.length === 0) {
    const ws = verifyWorkspace(options);
    if (jsonOutput) {
      console.log(JSON.stringify(ws, null, 2));
    } else {
      const report = formatReport(ws);
      if (!quiet || !ws.valid) console.log(report);
    }
    return ws.valid ? 0 : 1;
  }

  const results = [];
  for (const target of targets) {
    if (existsSync(target)) {
      results.push(verifyFile(target, options));
    } else {
      // Treat as proposal tag
      const propResult = verifyProposal(target, options);
      if (propResult.files.length > 0) {
        results.push(...propResult.files);
      } else {
        results.push({
          file: target,
          valid: false,
          errors: propResult.errors,
          references: [],
        });
      }
    }
  }

  const allErrors = results.flatMap((r) => r.errors);
  const isValid = allErrors.length === 0;

  if (jsonOutput) {
    console.log(JSON.stringify({ valid: isValid, files: results }, null, 2));
  } else {
    const report = formatReport(results);
    if (!quiet || !isValid) console.log(report);
  }

  return isValid ? 0 : 1;
}

if (import.meta.main) {
  const code = await runCli();
  process.exit(code);
}
