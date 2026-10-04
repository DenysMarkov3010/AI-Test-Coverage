/**
 * HTML “preview” for repo Markdown guides (Cursor / VS Code–style readable layout).
 * Used by web-ui-server.js for FULL_FLOW_GUIDE.md, UPDATED_CSV_FLOW.md, ADO_TEST_PLANS.md.
 */
const { marked } = require("marked");

marked.setOptions({
  gfm: true,
  breaks: false,
});

function wantsRawMarkdown(req) {
  try {
    const host = req.headers.host || "127.0.0.1";
    const u = new URL(req.url || "/", `http://${host}`);
    if (u.searchParams.get("raw") === "1") return true;
  } catch {
    /* ignore */
  }
  const accept = String(req.headers.accept || "");
  const wantsMd = /\btext\/markdown\b/i.test(accept);
  const wantsHtml = /\btext\/html\b/i.test(accept);
  if (wantsMd && !wantsHtml) return true;
  return false;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PREVIEW_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --text: #24292f;
  --muted: #57606a;
  --border: #d0d7de;
  --code-bg: #f6f8fa;
  --link: #0969da;
  --blockquote: #6e7781;
  --toolbar-bg: #f6f8fa;
  --toolbar-border: #d0d7de;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1e;
    --text: #d4d4d4;
    --muted: #9d9d9d;
    --border: #3c3c3c;
    --code-bg: #2d2d2d;
    --link: #58a6ff;
    --blockquote: #8b949e;
    --toolbar-bg: #252526;
    --toolbar-border: #3c3c3c;
  }
}
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", sans-serif;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
}
.md-toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0.65rem 1.25rem;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--toolbar-border);
  font-size: 0.875rem;
}
.md-title {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
}
.md-toolbar a {
  color: var(--link);
  text-decoration: none;
  white-space: nowrap;
}
.md-toolbar a:hover { text-decoration: underline; }
.markdown-body {
  max-width: 920px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 4rem;
  word-wrap: break-word;
}
.markdown-body > :first-child { margin-top: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
  font-weight: 600;
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}
.markdown-body h1 { font-size: 2em; padding-bottom: 0.2em; border-bottom: 1px solid var(--border); }
.markdown-body h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid var(--border); }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h4 { font-size: 1.05em; }
.markdown-body p { margin: 0 0 1em; }
.markdown-body ul, .markdown-body ol { margin: 0 0 1em; padding-left: 1.75em; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body li > p { margin: 0.35em 0; }
.markdown-body blockquote {
  margin: 0 0 1em;
  padding: 0 0.9em;
  border-left: 0.25em solid var(--border);
  color: var(--blockquote);
}
.markdown-body hr {
  height: 0;
  margin: 1.5em 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.markdown-body a { color: var(--link); }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body code {
  font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--code-bg);
}
.markdown-body pre {
  margin: 0 0 1em;
  padding: 1rem 1.1rem;
  overflow: auto;
  font-size: 0.875rem;
  line-height: 1.5;
  border-radius: 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
}
.markdown-body pre code {
  padding: 0;
  background: none;
  border-radius: 0;
  font-size: inherit;
}
.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1em;
  font-size: 0.95em;
}
.markdown-body table th,
.markdown-body table td {
  padding: 0.45em 0.75em;
  border: 1px solid var(--border);
}
.markdown-body table th {
  font-weight: 600;
  background: var(--code-bg);
}
@media (prefers-color-scheme: light) {
  .markdown-body table tbody tr:nth-child(even) { background: #f6f8fa; }
}
@media (prefers-color-scheme: dark) {
  .markdown-body table tbody tr:nth-child(even) { background: #252526; }
}
.markdown-body img { max-width: 100%; height: auto; }
`;

function buildGuideHtml(title, markdown) {
  const inner = marked.parse(markdown);
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${PREVIEW_CSS}</style>
</head>
<body>
<header class="md-toolbar">
  <span class="md-title">${safeTitle}</span>
  <a class="md-raw" href="?raw=1">Raw Markdown</a>
</header>
<main class="markdown-body">
${inner}
</main>
</body>
</html>`;
}

module.exports = { wantsRawMarkdown, buildGuideHtml };
