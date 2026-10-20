/**
 * "Analyze requirements" result → Markdown. Shared by the page (Copy / Download .md) and by
 * requirements-analysis.js when it runs from a shell. Lives in web/ for the same reason as
 * bdd-format.js: the browser and Node load the same file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AnalysisFormat = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const PRIORITY_TITLE = { blocker: "Blockers — must be answered before work starts", high: "High", medium: "Medium" };
  const VERDICT_TITLE = { ready: "Ready", "needs clarification": "Needs clarification", "not ready": "Not ready" };

  const s = (v) => String(v == null ? "" : v).trim();
  const oneLine = (v) => s(v).replace(/\s*\n\s*/g, " ");

  function sourcesLine(src) {
    if (!src) return "";
    const parts = ["ticket"];
    if (src.comments) parts.push(`${src.comments} comment(s)`);
    if (src.relatedTickets && src.relatedTickets.length) parts.push(`related: ${src.relatedTickets.join(", ")}`);
    if (src.confluence) parts.push("Confluence");
    if (src.design) parts.push(`${src.design} design link(s)`);
    if (src.prototype) parts.push(`${src.prototype} prototype link(s)`);
    if (src.attachments) parts.push(`${src.attachments} attachment(s)`);
    if (src.relatedTestCases && src.relatedTestCases.length) parts.push(`${src.relatedTestCases.length} related test case source(s)`);
    return parts.join(" · ");
  }

  /** Questions only, numbered, ready to paste into a Jira comment or a meeting note. */
  function questionsToMarkdown(result) {
    const a = (result && result.analysis) || {};
    const qs = a.questions || [];
    if (!qs.length) return "No open questions.";
    return qs
      .map((q) => `${q.id}. ${oneLine(q.question)}${q.askWho ? ` _(→ ${q.askWho})_` : ""}${q.priority === "blocker" ? " **[blocker]**" : ""}`)
      .join("\n");
  }

  function toMarkdown(result) {
    const r = result || {};
    const a = r.analysis || {};
    const out = [];
    out.push(`# Requirements analysis — ${s(r.issueKey)}${r.summary ? `: ${oneLine(r.summary)}` : ""}`);
    const meta = [r.generatedAt ? `Generated ${s(r.generatedAt).slice(0, 16).replace("T", " ")} UTC` : "", sourcesLine(r.sources)]
      .filter(Boolean)
      .join(" · ");
    if (meta) out.push(`_${meta}_`);

    out.push("", `## Verdict: ${VERDICT_TITLE[a.verdict] || s(a.verdict)}`);
    if (a.verdictReason) out.push(oneLine(a.verdictReason));
    if (a.understanding) out.push("", `**Understanding.** ${oneLine(a.understanding)}`);

    if ((a.setAssessment || []).length) {
      out.push("", "| ISO/IEC/IEEE 29148 (set) | Rating | Note |", "|---|---|---|");
      for (const c of a.setAssessment) out.push(`| ${s(c.characteristic)} | ${s(c.rating)} | ${oneLine(c.note).replace(/\|/g, "/")} |`);
    }

    const qs = a.questions || [];
    out.push("", `## Questions for grooming (${qs.length})`);
    if (!qs.length) out.push("No open questions.");
    for (const p of ["blocker", "high", "medium"]) {
      const group = qs.filter((q) => q.priority === p);
      if (!group.length) continue;
      out.push("", `### ${PRIORITY_TITLE[p]}`);
      for (const q of group) {
        const tags = [q.category, q.askWho && `ask: ${q.askWho}`, q.isoCharacteristic && `ISO: ${q.isoCharacteristic}`].filter(Boolean).join(" · ");
        out.push(`- **${q.id}.** ${oneLine(q.question)}${tags ? ` _(${tags})_` : ""}${q.stillOpenFromComments ? " — _still open from the comments_" : ""}`);
        if (q.why) out.push(`  - Why: ${oneLine(q.why)}`);
        if (q.trigger) out.push(`  - Trigger: ${oneLine(q.trigger)}`);
        if (q.assumptionIfUnanswered) out.push(`  - If unanswered, assume: ${oneLine(q.assumptionIfUnanswered)}`);
      }
    }

    if ((a.differences || []).length) {
      out.push("", `## Differences between sources (${a.differences.length})`);
      for (const d of a.differences) {
        out.push("", `### ${oneLine(d.topic)}`);
        for (const st of d.statements || []) out.push(`- **${s(st.source)}:** ${oneLine(st.says)}`);
        if (d.impact) out.push(`- _Impact:_ ${oneLine(d.impact)}`);
        if (d.question) out.push(`- _Question:_ ${oneLine(d.question)}`);
      }
    }

    if ((a.gaps || []).length) {
      out.push("", `## Missing information (${a.gaps.length})`);
      for (const g of a.gaps) out.push(`- **${oneLine(g.area)}:** ${oneLine(g.missing)}${g.whyItMatters ? ` — ${oneLine(g.whyItMatters)}` : ""}`);
    }

    if ((a.qualityIssues || []).length) {
      out.push("", `## Requirement quality (ISO/IEC/IEEE 29148) (${a.qualityIssues.length})`);
      for (const q of a.qualityIssues) {
        out.push(`- "${oneLine(q.text)}"${q.source ? ` _(${s(q.source)})_` : ""} — ${(q.characteristics || []).join(", ")}`);
        if (q.problem) out.push(`  - Problem: ${oneLine(q.problem)}`);
        if (q.suggestedRewrite) out.push(`  - Suggested: ${oneLine(q.suggestedRewrite)}`);
      }
    }

    const listSection = (title, items) => {
      if (!(items || []).length) return;
      out.push("", `## ${title}`);
      for (const it of items) out.push(`- ${oneLine(it)}`);
    };
    listSection("Already decided (do not reopen)", a.alreadyDecided);
    listSection("Assumptions made by the analysis", a.assumptions);
    listSection("Context", a.contextNotes);

    return `${out.join("\n")}\n`;
  }

  return { toMarkdown, questionsToMarkdown, PRIORITY_TITLE, VERDICT_TITLE };
});
