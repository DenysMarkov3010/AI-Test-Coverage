/**
 * The HTML rules for a TMS whose text fields are a WYSIWYG editor.
 *
 * Shared by the TestRail and the Zephyr Essential importers, because both
 * products store their rich-text fields as HTML and both punish the same
 * mistake: text posted as plain lines comes back inside one paragraph with the
 * newlines intact, and a browser collapses those into spaces. That is what ran
 * a list of preconditions, or a multi-line expected result, together into one
 * long line. Real markup — `<ul>`, `<ol>`, `<br>` — survives the round trip and
 * renders line for line (measured against live instances of both; see section 8
 * of TESTRAIL.md).
 *
 * Azure DevOps is deliberately NOT a client of this module. Its steps field is
 * XML carrying escaped HTML, and it keeps "- " lines as literal text joined by
 * `<br/>` on purpose: the browser indents a `<ul>` and swaps the author's "-"
 * for its own glyph, so the work item would stop matching the draft the QA
 * engineer approved. See buildTcmStepsXml() in ado-sync-csv.js. The rule that
 * IS shared with it is the escaping: anything out of the CSV is escaped first,
 * or a step reading `value < 5` is swallowed as an unknown tag.
 *
 * Every function here takes one CSV cell and returns an HTML fragment.
 */

/** A leading list marker, with the indentation a hand-edited cell may carry. */
const BULLET_RE = /^\s*[-*•]\s+/;

/**
 * Text → HTML text. Quotes are left alone: inside HTML text a quote is just a
 * character, and that is how both products store their own cells.
 */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `["a", "b"]` → `<ul><li>a</li><li>b</li></ul>`. Items must already be escaped. */
function htmlList(tag, items) {
  const nodes = items.map((item) => `<li>${item}</li>`).join("");
  return `<${tag}>${nodes}</${tag}>`;
}

/** The agent's filler for "nothing to assert"; repeating it on a step adds noise. */
function isFillerExpected(expected) {
  const t = String(expected == null ? "" : expected).trim();
  return t === "—" || t === "-" || t === "–";
}

/**
 * One step cell → the HTML the TMS actually renders line for line.
 *
 * Three shapes reach here with more than one line, and all three come out of
 * the same generator, so the rule is the same for a test case, a checklist and
 * a BDD scenario:
 *
 *   - a bulleted expected result ("- a\n- b") → a real `<ul>`
 *   - a Gherkin block ("Then …\nAnd …")      → `<br>`-separated lines, so each
 *                                               keyword keeps the start of its line
 *   - a checklist item, which is a single line → escaped text, no wrapper
 *
 * A one-line cell is never wrapped: a lone `<ul>` around a single item adds an
 * indent and a bullet glyph the author did not write.
 */
function formatRichTextCell(raw) {
  const lines = String(raw == null ? "" : raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  if (lines.length === 1) return escapeHtml(lines[0]);
  if (lines.every((l) => BULLET_RE.test(l))) {
    return htmlList("ul", lines.map((l) => escapeHtml(l.replace(BULLET_RE, ""))));
  }
  return lines.map(escapeHtml).join("<br>");
}

/**
 * Render the preconditions as a bullet list, one thesis per line.
 *
 * Two input shapes exist in real CSVs (the good and bad examples in
 * TEST_CASE_FORMAT.md): the current one, already a "- " list across several
 * lines, and the legacy one-liner with semicolons. A multi-line cell is split
 * on its own lines and nothing else, so a semicolon inside a written-out
 * precondition is left alone. Only a single-line cell is split on semicolons —
 * there it is the only separator the author had.
 *
 * Unlike a step cell, a single precondition still becomes a `<ul>`: it is a
 * list of one that the next edit grows, and both products render that section
 * as a list anyway.
 *
 * @param {string} raw text following the "Preconditions:" prefix
 * @returns {string} a `<ul>` list, or "" when there is nothing to say
 */
function formatPreconditions(raw) {
  // The "- " bullets come off here: the markup carries them from this point on.
  const lines = String(raw == null ? "" : raw)
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET_RE, "").trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const items =
    lines.length === 1
      ? lines[0]
          .split(";")
          .map((part) => part.trim().replace(/[.;]+$/, "").trim())
          .filter(Boolean)
      : lines;
  if (!items.length) return "";

  return htmlList("ul", items.map(escapeHtml));
}

/**
 * The way back: one rich-text field → the CSV cell it was written from.
 *
 * The inverse of formatRichTextCell() and formatPreconditions(), used when existing cases are
 * exported back to an agent CSV: a `<ul>` becomes "- " lines again, `<br>` and paragraph ends
 * become newlines, and every other tag goes. Plain text — Xray keeps its cells that way — passes
 * through with only the entities decoded.
 *
 * @param {string} raw
 * @returns {string}
 */
function htmlToCell(raw) {
  return String(raw == null ? "" : raw)
    .replace(/\r\n/g, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

module.exports = {
  escapeHtml,
  htmlList,
  isFillerExpected,
  formatRichTextCell,
  formatPreconditions,
  htmlToCell,
};
