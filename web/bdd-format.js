/**
 * Gherkin ⇄ CSV-step conversion, shared by the Node scripts and the review panel.
 *
 * WHY IT LIVES IN `web/`: the review panel renders and re-parses Gherkin in the
 * browser, and `agent-docs.js` / `agent-update-csv.js` / `ado-sync-csv.js` do the
 * same conversion server-side. Only files under `web/` are served to the page
 * (see `serveStatic` in web-ui-server.js), so this is the one directory both
 * sides can reach. The UMD wrapper below is what makes `require("./web/bdd-format.js")`
 * and `<script src="bdd-format.js">` return the same code — a second copy of the
 * parser would drift, and a drifting parser silently mangles test steps.
 *
 * THE CANONICAL SHAPE. Everything downstream (CSV, Azure DevOps, TestRail, the
 * Jira comment, the approval reader) speaks one shape and one shape only:
 *
 *     { stepNumber, action, expected }
 *
 * A BDD test case is NOT a different shape — it is that same shape with Gherkin
 * keywords kept inside the text:
 *
 *     Given the user has a shipped order         → step 1 action
 *     And the order was shipped at 09:15         → step 2 action
 *     When the user opens the "Orders" tab       → step 3 action
 *     Then the "Latest order" card shows 09:15   → step 3 expected
 *     And the time is in the store's zone        → step 3 expected (2nd line)
 *
 * Given/When lines each get their own row, so Azure DevOps' and TestRail's step
 * grids stay readable line by line; Then lines attach to the Expected column of
 * the row they verify, which is what both grids are for. Because the keyword
 * stays in the text, the mapping is reversible — that is what lets the Update
 * flow read a CSV back and know, per test case and with no extra column, which
 * cases were written as Gherkin and which were not.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BddFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  /** Keywords that open a phase. `And` / `But` / `*` continue the previous one. */
  const PRIMARY_KEYWORDS = ["Given", "When", "Then"];
  const CONTINUATION_KEYWORDS = ["And", "But"];

  const LINE_RE = /^(Given|When|Then|And|But)\b[ \t]*(.*)$/i;
  const BULLET_RE = /^[-*•]\s+/;

  /**
   * The standard format's leading "Preconditions:" row, which a scenario also
   * carries — see `splitPreconditionsRow` for why it is not a Gherkin line.
   */
  const PRECONDITIONS_RE = /^preconditions?\s*:\s*/i;
  /** What the standard format puts in Expected on that row: "nothing to assert". */
  const PRECONDITIONS_EXPECTED = "—";

  /** Canonical casing for a keyword the model may have written in any case. */
  function normalizeKeyword(raw) {
    const k = String(raw || "").trim().toLowerCase();
    const all = [...PRIMARY_KEYWORDS, ...CONTINUATION_KEYWORDS];
    return all.find((x) => x.toLowerCase() === k) || "";
  }

  /**
   * One cell (an `action` or `expected` value) → its individual Gherkin lines.
   * Leading "- " bullets are stripped: the expected column is bulleted by the
   * standard-format normaliser elsewhere in the project, and an old CSV may
   * still carry that decoration.
   */
  function splitCellLines(cell) {
    return String(cell == null ? "" : cell)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.replace(BULLET_RE, "").trim())
      .filter(Boolean);
  }

  /** `"given the user is logged in"` → `{ keyword: "Given", text: "the user is logged in" }`. */
  function parseGherkinLine(line) {
    const m = String(line || "").trim().match(LINE_RE);
    if (!m) return null;
    const keyword = normalizeKeyword(m[1]);
    if (!keyword) return null;
    return { keyword, text: String(m[2] || "").trim() };
  }

  function isGherkinLine(line) {
    return parseGherkinLine(line) !== null;
  }

  /** Re-render a parsed line, so casing and spacing are uniform whatever came in. */
  function formatGherkinLine(keyword, text) {
    const kw = normalizeKeyword(keyword) || "And";
    const body = String(text || "").trim();
    return body ? `${kw} ${body}` : kw;
  }

  function sortedSteps(steps) {
    return [...(Array.isArray(steps) ? steps : [])].sort(
      (a, b) => (a.stepNumber || 0) - (b.stepNumber || 0)
    );
  }

  /** True for the standard format's "Preconditions: …" row. */
  function isPreconditionsStep(step) {
    return PRECONDITIONS_RE.test(String((step && step.action) || "").trim());
  }

  /**
   * Peel the leading "Preconditions:" row off a scenario.
   *
   * A scenario keeps it in `steps[0]`, exactly like a standard test case, so the
   * CSV needs no extra column and every writer downstream already handles it.
   * But it is NOT part of the Gherkin: TestRail documents its Preconditions
   * section as the setup a run needs — environment, access, test data — while
   * `Given` carries the scenario's own business context. So the row is stripped
   * before anything reads or checks the Gherkin, and added back when the rows
   * are rebuilt.
   *
   * @returns {{ preconditions: string, steps: Array }} `preconditions` without its prefix
   */
  function splitPreconditionsRow(steps) {
    const sorted = sortedSteps(steps);
    if (!sorted.length || !isPreconditionsStep(sorted[0])) {
      return { preconditions: "", steps: sorted };
    }
    return {
      preconditions: String(sorted[0].action || "").replace(PRECONDITIONS_RE, "").trim(),
      steps: sorted.slice(1),
    };
  }

  /** The row form of a preconditions block, or null when there is nothing to say. */
  function preconditionsStep(text) {
    const lines = splitCellLines(text);
    if (!lines.length) return null;
    // One thesis per line, "- " bulleted when there are several — the shape the
    // standard format already uses and that TestRail renders as a <ul>.
    const body = lines.length === 1 ? ` ${lines[0]}` : `\n${lines.map((l) => `- ${l}`).join("\n")}`;
    return { stepNumber: 1, action: `Preconditions:${body}`, expected: PRECONDITIONS_EXPECTED };
  }

  function renumber(steps) {
    return steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
  }

  /**
   * Canonical steps → the flat list of Gherkin lines they encode.
   * Action lines come first in each row, then the Then lines that verify it,
   * which is exactly the order they were written in. The preconditions row is
   * not Gherkin and is left out.
   */
  function stepsToGherkinLines(steps) {
    const out = [];
    for (const s of splitPreconditionsRow(steps).steps) {
      out.push(...splitCellLines(s && s.action));
      out.push(...splitCellLines(s && s.expected));
    }
    return out;
  }

  /**
   * Gherkin lines → canonical steps.
   *
   * Every Given/When line becomes its own row; every Then line lands in the
   * Expected column of the row above it, joined by newlines when a Then has its
   * own `And` continuations. A line with no keyword is kept verbatim as a
   * continuation of whatever phase is open, so hand-editing in the review panel
   * never silently drops text.
   */
  function gherkinLinesToSteps(lines, options = {}) {
    const steps = [];
    let phase = null; // the last primary keyword seen

    const pushAction = (line) => {
      steps.push({ stepNumber: steps.length + 1, action: line, expected: "" });
    };
    const pushExpected = (line) => {
      if (!steps.length) {
        // A Scenario that opens on Then has nothing to attach to; keep the line
        // as an action so it survives the round trip in the same position.
        pushAction(line);
        return;
      }
      const last = steps[steps.length - 1];
      last.expected = last.expected ? `${last.expected}\n${line}` : line;
    };

    for (const raw of Array.isArray(lines) ? lines : []) {
      const text = String(raw == null ? "" : raw).replace(BULLET_RE, "").trim();
      if (!text) continue;
      const parsed = parseGherkinLine(text);
      if (!parsed) {
        // Unkeyworded text: append to the open phase rather than lose it.
        if (phase === "Then") pushExpected(text);
        else if (steps.length) {
          const last = steps[steps.length - 1];
          last.action = last.action ? `${last.action}\n${text}` : text;
        } else pushAction(text);
        continue;
      }
      const isContinuation = CONTINUATION_KEYWORDS.includes(parsed.keyword);
      const primary = isContinuation ? phase || "Given" : parsed.keyword;
      const line = formatGherkinLine(parsed.keyword, parsed.text);
      phase = primary;
      if (primary === "Then") pushExpected(line);
      else pushAction(line);
    }

    const pre = preconditionsStep(options.preconditions);
    return pre ? renumber([pre, ...steps]) : steps;
  }

  /**
   * Is this test case written as Gherkin?
   *
   * Strict on purpose — this is the switch the Update flow uses to decide which
   * prompt a CSV block gets, and the switch the Azure DevOps import uses to skip
   * generating a second BDD copy into the Summary. Every line must carry a
   * keyword and at least one must open the scenario, so a standard case that
   * happens to contain one "Given the user is logged in" step is not mistaken
   * for a BDD one.
   */
  function looksLikeGherkinSteps(steps) {
    const lines = stepsToGherkinLines(steps);
    if (lines.length < 2) return false;
    if (!lines.every(isGherkinLine)) return false;
    return lines.some((l) => /^(Given|When)\b/i.test(l.trim()));
  }

  /** @param {{ steps?: Array }} tc */
  function isBddTestCase(tc) {
    return !!tc && looksLikeGherkinSteps(tc.steps);
  }

  /** True when at least one case in the list is Gherkin. */
  function anyBddTestCase(testCases) {
    return (Array.isArray(testCases) ? testCases : []).some(isBddTestCase);
  }

  /**
   * The scenario body as editable text: one Gherkin line per row, no indentation
   * (the review panel textarea and the Jira code block both add their own).
   */
  function stepsToGherkinText(steps) {
    return stepsToGherkinLines(steps).join("\n");
  }

  /** Free text from the review textarea → canonical steps. */
  function gherkinTextToSteps(text, options = {}) {
    const lines = String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .split("\n")
      // A pasted scenario often carries its own header lines; the title, the
      // feature and the preconditions are edited in their own fields, so drop
      // them here rather than let them become step lines.
      .filter((l) => !/^\s*(Feature|Scenario Outline|Scenario|Background)\s*:/i.test(l))
      .filter((l) => !PRECONDITIONS_RE.test(l.trim()));
    return gherkinLinesToSteps(lines, options);
  }

  /**
   * One test case rendered as a complete `Scenario:` block — what the Jira
   * comment and the review panel preview show.
   */
  function testCaseToScenarioText(tc) {
    const title = String((tc && tc.title) || "Scenario").trim();
    const body = stepsToGherkinLines(tc && tc.steps).map((l) => `  ${l}`);
    return [`Scenario: ${title}`, ...body].join("\n");
  }

  /**
   * The whole suite as one Gherkin Feature block.
   * @param {string} feature
   * @param {Array} testCases
   * @param {string} [description] the "As a … I want … So that …" lines
   */
  function testCasesToFeatureText(feature, testCases, description) {
    const head = [`Feature: ${String(feature || "").trim() || "Test design"}`];
    const desc = String(description || "").trim();
    if (desc) {
      head.push(...desc.split(/\r?\n/).map((l) => `  ${l.trim()}`).filter((l) => l.trim()));
    }
    const blocks = (Array.isArray(testCases) ? testCases : []).map((tc) =>
      testCaseToScenarioText(tc)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
    return [head.join("\n"), ...blocks].join("\n\n");
  }

  /**
   * Accept whatever the model returned for one scenario's steps and produce the
   * canonical shape.
   *
   * Three inputs show up in practice: the string array the BDD prompts ask for,
   * a `{ keyword, text }` array, and the `{ action, expected }` array the model
   * falls back to when it pattern-matches the standard prompt. All three are
   * routed through `gherkinLinesToSteps`, so the row grouping is decided here
   * and not by the model — and re-running it on already-canonical steps is a
   * no-op, which keeps regeneration idempotent.
   */
  function toCanonicalSteps(rawSteps, options = {}) {
    const raw = Array.isArray(rawSteps) ? rawSteps : [];
    if (!raw.length) return gherkinLinesToSteps([], options);

    const lines = [];
    for (const s of raw) {
      if (typeof s === "string") {
        lines.push(s);
        continue;
      }
      if (!s || typeof s !== "object") continue;
      if (s.action !== undefined || s.expected !== undefined) {
        // The preconditions row is not Gherkin and travels in `options`; feeding
        // it back in here would append it to the scenario a second time on every
        // re-normalisation. Callers that have canonical rows must pass it via
        // `options.preconditions` — `normalizeBddTestCases` does exactly that.
        if (isPreconditionsStep(s)) continue;
        lines.push(...splitCellLines(s.action), ...splitCellLines(s.expected));
        continue;
      }
      if (s.keyword !== undefined || s.text !== undefined) {
        lines.push(formatGherkinLine(s.keyword, s.text));
        continue;
      }
      const only = Object.values(s).find((v) => typeof v === "string");
      if (only) lines.push(only);
    }
    return gherkinLinesToSteps(lines, options);
  }

  /**
   * Normalise a whole list of BDD test cases coming back from an LLM.
   *
   * The prompts ask for `preconditions` as its own key, because asking a model
   * to hide a non-Gherkin line inside a Gherkin array invites it to emit
   * "Given"-shaped preconditions instead. It is folded into `steps[0]` here and
   * the key is dropped, so the test case keeps ONE representation of its rows —
   * read it back with `splitPreconditionsRow`.
   */
  function normalizeBddTestCases(testCases) {
    return (Array.isArray(testCases) ? testCases : []).map((raw) => {
      const tc = raw || {};
      const steps = Array.isArray(tc.steps) ? tc.steps : [];
      // Re-normalising an already-canonical case must not lose its row.
      const alreadyRows = steps.some((s) => s && typeof s === "object" && s.action !== undefined);
      const carried = alreadyRows ? splitPreconditionsRow(steps).preconditions : "";
      const preconditions = String(tc.preconditions || carried || "").trim();
      const { preconditions: _folded, ...rest } = tc;
      return { ...rest, steps: toCanonicalSteps(steps, { preconditions }) };
    });
  }

  /**
   * Does this expected-result cell hold Gherkin?
   *
   * The standard flow reformats a multi-part expected result into "- " bullets
   * and splits it on sentence ends. Both would wreck a `Then … / And …` block,
   * so the normaliser consults this first and leaves Gherkin alone.
   */
  function isGherkinExpectedCell(text) {
    const lines = splitCellLines(text);
    return lines.length > 0 && lines.every(isGherkinLine);
  }

  return {
    PRIMARY_KEYWORDS,
    CONTINUATION_KEYWORDS,
    normalizeKeyword,
    splitCellLines,
    parseGherkinLine,
    isGherkinLine,
    formatGherkinLine,
    isPreconditionsStep,
    splitPreconditionsRow,
    preconditionsStep,
    stepsToGherkinLines,
    gherkinLinesToSteps,
    looksLikeGherkinSteps,
    isBddTestCase,
    anyBddTestCase,
    stepsToGherkinText,
    gherkinTextToSteps,
    testCaseToScenarioText,
    testCasesToFeatureText,
    toCanonicalSteps,
    normalizeBddTestCases,
    isGherkinExpectedCell,
  };
});
