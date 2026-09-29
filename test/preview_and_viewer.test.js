import { describe, it, expect } from "bun:test";
import { marked } from "marked";
import "../cli/proposals.js";

describe("Proposal Viewer and Preview Popover Tests", () => {
  it("renders code references with data-preview-code and appropriate line numbers", () => {
    const markdown = "Check out `package.json#L1-L5` for project setup.";
    const html = marked.parse(markdown);
    expect(html).toContain('data-preview-code="package.json#L1-L5"');
    expect(html).toContain('href="/source?file=package.json&lines=1-5#L1-5"');
    expect(html).toContain('<a class="file-ref"');
  });

  it("renders internal section anchor links with data-preview-anchor", () => {
    const markdown = "Refer to [RFC Scope](#clause-scope) for details.";
    const html = marked.parse(markdown);
    expect(html).toContain('data-preview-anchor="#clause-scope"');
    expect(html).toContain('href="#clause-scope"');
    expect(html).toContain('<a class="internal-link"');
  });

  it("renders external proposal references with data-preview", () => {
    const markdown = "Depends on [RFC 001](001_sse_liveness_resume#clause-lifecycle) or `002_comment_box_review_actions`.";
    const html = marked.parse(markdown);
    expect(html).toContain('data-preview="/proposal/001_sse_liveness_resume#clause-lifecycle"');
    expect(html).toContain('data-preview="/proposal/002_comment_box_review_actions"');
    expect(html).toContain('<a class="paper-link"');
  });

  it("renders clause headings with clause-link containing pilcrow ¶", () => {
    const markdown = "## Proposed Design";
    const html = marked.parse(markdown);
    expect(html).toContain('<h2 id="clause-proposed-design">');
    expect(html).toContain('<a class="clause-link" href="#clause-proposed-design"');
    expect(html).toContain("¶</a></h2>");
  });

  it("ensures sourceview CSS specifies 0.5em line-height", async () => {
    const proposalsModule = await Bun.file("cli/proposals.js").text();
    expect(proposalsModule).toContain(".sourceview{font:0.85rem/0.5em ui-monospace");
    expect(proposalsModule).toContain("line-height:0.5em!important");
    expect(proposalsModule).toContain(".sourceview .line{display:block;min-height:0.5em;line-height:0.5em!important");
    expect(proposalsModule).toContain(".sourceview pre.shiki{background:#fff!important;border:1px solid #d0d7de;padding:.4rem 0;overflow:auto;line-height:0.5em!important}");
  });

  it("ensures client script defines esc and avoids ReferenceError on undefined escapeHtml", async () => {
    const proposalsModule = await Bun.file("cli/proposals.js").text();
    // Browser client script must define its own escaping function
    expect(proposalsModule).toContain("const esc = (s) =>");
    // Client script must not use bare escapeHtml in browser template literals
    const scriptStart = proposalsModule.indexOf("<script>\n  (() => { const source = new EventSource");
    const scriptEnd = proposalsModule.indexOf("</script>", scriptStart);
    const scriptContent = proposalsModule.slice(scriptStart, scriptEnd);
    expect(scriptContent).not.toContain("escapeHtml(");
    expect(scriptContent).toContain("${esc(");
  });
});
