/**
 * Shared logic for the "related Jira issues" search — used by agent-docs.js
 * (generation context) and preview-related-issues.js (web UI preview), so the
 * preview always shows exactly what the agent will use.
 */

// Stop words to skip when building title-based JQL (reduces noise)
const RELATED_ISSUES_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "are", "but", "not", "you", "all", "can", "had", "her", "his",
  "was", "one", "our", "out", "has", "have", "this", "that", "what", "when", "which", "who", "will",
  "your", "about", "into", "than", "them", "then", "some", "would", "could", "should", "there", "their"
]);

/** Issue types searched when RELATED_ISSUES_TYPES is not set. */
const DEFAULT_RELATED_ISSUE_TYPES = ["Story", "Improvement"];

/**
 * Extract significant words from issue summary (title) for similar-title JQL search.
 * @param {string} summary - Issue summary/title
 * @param {number} maxWords - Max words to use in JQL (default 5)
 * @returns {string[]} Words of length >= 3, not stop words
 */
function getTitleSearchWords(summary, maxWords = 5) {
  if (!summary || typeof summary !== "string") return [];
  const words = summary
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 3 && !RELATED_ISSUES_STOP_WORDS.has(w));
  const seen = new Set();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return unique.slice(0, maxWords);
}

/**
 * Parse optional RELATED_ISSUES_KEYWORDS from env.
 * Supports comma/semicolon/newline separated values (phrases allowed).
 * Example: "payment, verification dashboard, status".
 * @param {string} raw
 * @param {number} maxWords
 * @returns {string[]}
 */
function parseRelatedIssuesKeywords(raw, maxWords = 10) {
  const input = String(raw || "").trim();
  if (!input) return [];
  const parts = input
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const normalized = p.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= maxWords) break;
  }
  return unique;
}

/**
 * Parse RELATED_ISSUES_TYPES (comma-separated issue type names) with fallback
 * to the default Story/Improvement set. Lets teams include e.g. Bug — past
 * bugs in an area are a strong signal of where it actually breaks.
 * @param {string} raw
 * @returns {string[]}
 */
function resolveRelatedIssueTypes(raw) {
  const parsed = parseRelatedIssuesKeywords(raw, 20);
  return parsed.length > 0 ? parsed : [...DEFAULT_RELATED_ISSUE_TYPES];
}

/** Escape a value used inside a quoted JQL string. */
function jqlQuote(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the JQL used for the related-issues search.
 * @param {{ projectKey: string, issueTypes: string[], queryWords: string[], excludeKey?: string }} params
 * @returns {string}
 */
function buildRelatedIssuesJql({ projectKey, issueTypes, queryWords, excludeKey }) {
  const types = (issueTypes && issueTypes.length ? issueTypes : DEFAULT_RELATED_ISSUE_TYPES)
    .map((t) => `"${jqlQuote(t)}"`)
    .join(", ");
  const summaryConditions = queryWords
    .map((w) => `summary ~ "${jqlQuote(w)}"`)
    .join(" OR ");
  const exclude = excludeKey ? ` AND key != ${excludeKey}` : "";
  return (
    `project = ${projectKey} AND issuetype in (${types}) ` +
    `AND (${summaryConditions})${exclude} ORDER BY updated DESC`
  );
}

module.exports = {
  RELATED_ISSUES_STOP_WORDS,
  DEFAULT_RELATED_ISSUE_TYPES,
  getTitleSearchWords,
  parseRelatedIssuesKeywords,
  resolveRelatedIssueTypes,
  buildRelatedIssuesJql,
};
