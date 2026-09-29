import { describe, it, expect } from "bun:test";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import {
  extractReferences,
  resolveAssetPath,
  resolveSourcePath,
  verifyMarkdown,
  verifyFile,
  verifyProposal,
  verifyWorkspace,
  formatReport,
  runCli,
  isExternalUrl,
  cleanTarget,
  parseCodeReference,
} from "../cli/verify.js";

const repoRoot = resolve(".");

describe("parseCodeReference and Helper functions", () => {
  it("detects external URLs, data URLs, and anchors", () => {
    expect(isExternalUrl("https://example.com/image.png")).toBe(true);
    expect(isExternalUrl("http://example.com/image.png")).toBe(true);
    expect(isExternalUrl("//example.com/image.png")).toBe(true);
    expect(isExternalUrl("data:image/png;base64,xxxx")).toBe(true);
    expect(isExternalUrl("mailto:user@example.com")).toBe(true);
    expect(isExternalUrl("#section-heading")).toBe(true);
    expect(isExternalUrl("assets/sample.png")).toBe(false);
    expect(isExternalUrl("cli/proposals.js")).toBe(false);
    expect(isExternalUrl("/source/file.ts")).toBe(false);
  });

  it("parses permastatic line range and commit hash from code references", () => {
    const p1 = parseCodeReference("cli/proposals.js#L10-L25?commit=98a092ab");
    expect(p1.filePath).toBe("cli/proposals.js");
    expect(p1.startLine).toBe(10);
    expect(p1.endLine).toBe(25);
    expect(p1.commit).toBe("98a092ab");

    const p2 = parseCodeReference("cli/proposals.js?commit=98a092ab#L42");
    expect(p2.filePath).toBe("cli/proposals.js");
    expect(p2.startLine).toBe(42);
    expect(p2.endLine).toBe(42);
    expect(p2.commit).toBe("98a092ab");

    const p3 = parseCodeReference("package.json#L5-15");
    expect(p3.filePath).toBe("package.json");
    expect(p3.startLine).toBe(5);
    expect(p3.endLine).toBe(15);
    expect(p3.commit).toBeNull();

    const p4 = parseCodeReference("cli/proposals.js:30-45");
    expect(p4.filePath).toBe("cli/proposals.js");
    expect(p4.startLine).toBe(30);
    expect(p4.endLine).toBe(45);

    const p5 = parseCodeReference("file:///home/user/code.ts#L12");
    expect(p5.filePath).toBe("/home/user/code.ts");
    expect(p5.startLine).toBe(12);
  });

  it("cleans target paths by stripping fragments, query params, and line numbers", () => {
    expect(cleanTarget("assets/sample.png#section")).toBe("assets/sample.png");
    expect(cleanTarget("assets/sample.png?raw=true")).toBe("assets/sample.png");
    expect(cleanTarget("cli/proposals.js:42")).toBe("cli/proposals.js");
    expect(cleanTarget("cli/proposals.js:42:10")).toBe("cli/proposals.js");
    expect(cleanTarget("file:///home/user/code.ts")).toBe("/home/user/code.ts");
    expect(cleanTarget("assets/my%20file.png")).toBe("assets/my file.png");
  });
});

describe("extractReferences", () => {
  it("extracts markdown images, links, codespans, and HTML tags with correct lines", () => {
    const md = `# Document Header

Here is an image: ![Visual preview](assets/sample.png)
And a source link: [proposals CLI](cli/proposals.js#L10-L20)
And an inline reference: \`cli/proposals.js:25\`
And a permastatic line range: \`cli/proposals.js#L10-L30?commit=c0d01c04\`

<img src="assets/sample.svg" alt="SVG diagram">

\`\`\`ts
// Code inside fence should be ignored
import { foo } from "./not-a-file.js";
\`\`\`

Inline code that is not a source file: \`status: pending\` and \`true\`.
`;

    const refs = extractReferences(md);
    expect(refs.length).toBe(5);

    const imgRef = refs.find((r) => r.target === "assets/sample.png");
    expect(imgRef).toBeDefined();
    expect(imgRef.category).toBe("asset");
    expect(imgRef.kind).toBe("markdown-image");
    expect(imgRef.line).toBe(3);

    const linkRef = refs.find((r) => r.target.startsWith("cli/proposals.js#L10-L20"));
    expect(linkRef).toBeDefined();
    expect(linkRef.category).toBe("source");
    expect(linkRef.kind).toBe("markdown-link");
    expect(linkRef.line).toBe(4);

    const codeRef = refs.find((r) => r.target.startsWith("cli/proposals.js:25"));
    expect(codeRef).toBeDefined();
    expect(codeRef.category).toBe("source");
    expect(codeRef.kind).toBe("codespan");
    expect(codeRef.line).toBe(5);

    const permaRef = refs.find((r) => r.target.includes("commit=c0d01c04"));
    expect(permaRef).toBeDefined();
    expect(permaRef.category).toBe("source");
    expect(permaRef.kind).toBe("codespan");
    expect(permaRef.line).toBe(6);

    const htmlRef = refs.find((r) => r.target === "assets/sample.svg");
    expect(htmlRef).toBeDefined();
    expect(htmlRef.category).toBe("asset");
    expect(htmlRef.kind).toBe("html-media");
    expect(htmlRef.line).toBe(8);
  });
});

describe("verifyMarkdown: Asset existence (within proposal, by coderef, by node_modules)", () => {
  const testDir = resolve("test_fixtures_asset");

  it("passes when referenced assets exist within proposal, coderef, or node_modules", () => {
    mkdirSync(join(testDir, "assets"), { recursive: true });
    writeFileSync(join(testDir, "assets", "logo.png"), "fake png");

    const md = `
# Title
![Proposal asset](assets/logo.png)
![Coderef asset](package.json)
<link rel="stylesheet" href="node_modules/katex/dist/katex.min.css">
`;
    const res = verifyMarkdown(md, { filePath: join(testDir, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("fails with line number when asset is missing", () => {
    const md = `# Title

Line 3 has missing image: ![Missing](assets/nonexistent.png)

Line 5 has missing HTML img: <img src="assets/missing_chart.svg">

Line 7 has missing asset link: [Missing SVG](assets/not_here.svg)
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBe(3);

    expect(res.errors[0].category).toBe("missing-asset");
    expect(res.errors[0].line).toBe(3);
    expect(res.errors[0].target).toBe("assets/nonexistent.png");

    expect(res.errors[1].category).toBe("missing-asset");
    expect(res.errors[1].line).toBe(5);
    expect(res.errors[1].target).toBe("assets/missing_chart.svg");

    expect(res.errors[2].category).toBe("missing-asset");
    expect(res.errors[2].line).toBe(7);
    expect(res.errors[2].target).toBe("assets/not_here.svg");
  });
});

describe("verifyMarkdown: Code references by project root and permastatic lines", () => {
  it("matches code references by project root", () => {
    const md = `
# Implementation Details

Refer to [proposals CLI](cli/proposals.js) and [package](package.json).
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
  });

  it("validates valid permastatic line range #L<LINE>[-LINE]", () => {
    const md = `
# Lines Check

Valid single line: \`package.json#L5\`
Valid range: [CLI lines](cli/proposals.js#L10-L30)
Valid range with commit: \`cli/proposals.js#L10-L20?commit=c0d01c04\`
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
  });

  it("fails when referenced line exceeds total lines in file", () => {
    const md = `
# Out of range line
\`package.json#L9999\`
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].message).toContain("exceeds total line count");
  });

  it("fails when line range end is before start", () => {
    const md = `
# Inverted line range
\`package.json#L30-L10\`
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].message).toContain("end line cannot be before start line");
  });

  it("fails when git commit hash does not exist", () => {
    const md = `
# Invalid commit
\`cli/proposals.js#L10?commit=0000000000000000000000000000000000000000\`
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].message).toContain("Git commit");
  });

  it("fails when referenced source code file does not exist", () => {
    const md = `
# Missing file
\`src/nonexistent-feature.ts\`
`;
    const res = verifyMarkdown(md, { filePath: join(repoRoot, "PROPOSAL.md"), repoRoot });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].category).toBe("missing-source");
  });
});

describe("verifyWorkspace and verifyProposal", () => {
  it("verifies proposal 002_comment_box_review_actions and its revisions", () => {
    const res = verifyProposal("002_comment_box_review_actions");
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
    expect(res.files.length).toBeGreaterThanOrEqual(4);
  });

  it("verifies all proposals in workspace cleanly", () => {
    const ws = verifyWorkspace();
    expect(ws.valid).toBe(true);
    expect(ws.totalErrors).toBe(0);
    expect(ws.totalProposals).toBeGreaterThanOrEqual(2);
    expect(ws.totalFiles).toBeGreaterThanOrEqual(7);
  });
});

describe("CLI runner and formatting", () => {
  it("formats report cleanly for successful checks", () => {
    const ws = verifyWorkspace();
    const output = formatReport(ws);
    expect(output).toContain("✔");
    expect(output).toContain("Passed:");
    expect(output).toContain("0 errors");
  });

  it("runCli returns exit code 0 on healthy proposals", async () => {
    const code = await runCli(["--quiet"]);
    expect(code).toBe(0);
  });

  it("runCli returns exit code 1 when target file has missing references", async () => {
    const tmpFile = resolve("test_broken.md");
    writeFileSync(tmpFile, "Missing: ![none](assets/ghost.png) and `src/ghost.js`\n");
    const code = await runCli(["--quiet", tmpFile]);
    expect(code).toBe(1);
    rmSync(tmpFile, { force: true });
  });
});
