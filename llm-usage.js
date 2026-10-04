/**
 * Token accounting for one run.
 *
 * OpenRouter returns an OpenAI-shaped `usage` object on every completion. Nothing used to read it,
 * so a run gave no idea what it cost — which matters here because one Create run can fire several
 * calls (generation, then a regeneration per item the reviewer is not happy with).
 *
 * Everything is read defensively: a provider that omits `usage`, or reports only some fields, must
 * not break generation. An absent count is treated as 0 and the call is still counted, so the
 * "calls" number never silently disagrees with reality.
 */

function createUsageTally() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, hasCost: false, byModel: {} };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fold one completion's usage into the tally.
 * @param {Object} tally - from createUsageTally
 * @param {string} model - model id the call actually went to (may be a fallback)
 * @param {Object} usage - `usage` straight off the OpenRouter response, may be undefined
 */
function addUsage(tally, model, usage) {
  const u = usage || {};
  const prompt = num(u.prompt_tokens ?? u.promptTokens);
  const completion = num(u.completion_tokens ?? u.completionTokens);
  // Prefer the reported total: some providers count reasoning tokens that the split omits.
  const total = num(u.total_tokens ?? u.totalTokens) || prompt + completion;
  const cost = num(u.cost);

  tally.calls += 1;
  tally.promptTokens += prompt;
  tally.completionTokens += completion;
  tally.totalTokens += total;
  if (cost) {
    tally.costUsd += cost;
    tally.hasCost = true;
  }

  const key = model || "unknown";
  const perModel = tally.byModel[key] || (tally.byModel[key] = { calls: 0, totalTokens: 0 });
  perModel.calls += 1;
  perModel.totalTokens += total;
  return tally;
}

/** Merge a tally reported by a child process into this one. */
function mergeUsage(target, other) {
  if (!other) return target;
  target.calls += num(other.calls);
  target.promptTokens += num(other.promptTokens);
  target.completionTokens += num(other.completionTokens);
  target.totalTokens += num(other.totalTokens);
  if (other.hasCost) {
    target.costUsd += num(other.costUsd);
    target.hasCost = true;
  }
  for (const [model, stats] of Object.entries(other.byModel || {})) {
    const perModel = target.byModel[model] || (target.byModel[model] = { calls: 0, totalTokens: 0 });
    perModel.calls += num(stats.calls);
    perModel.totalTokens += num(stats.totalTokens);
  }
  return target;
}

function formatInt(n) {
  return num(n).toLocaleString("en-US");
}

/** One-line summary for the run log. Returns "" when no call was made. */
function formatUsage(tally) {
  if (!tally || !tally.calls) return "";
  const parts = [
    `${formatInt(tally.totalTokens)} tokens`,
    `${formatInt(tally.promptTokens)} in + ${formatInt(tally.completionTokens)} out`,
    `${tally.calls} LLM call${tally.calls === 1 ? "" : "s"}`,
  ];
  if (tally.hasCost) parts.push(`$${tally.costUsd.toFixed(4)}`);
  const models = Object.entries(tally.byModel)
    .map(([model, s]) => `${model} x${s.calls}`)
    .join(", ");
  return `${parts.join(" · ")}${models ? ` — ${models}` : ""}`;
}

/** Print the summary, tagged so the web UI can pick it out of the streamed log. */
function logUsage(tally, label = "this run") {
  const line = formatUsage(tally);
  if (line) console.log(`🧮 Tokens used ${label}: ${line}`);
}

module.exports = { createUsageTally, addUsage, mergeUsage, formatUsage, logUsage };
