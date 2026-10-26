/**
 * The Claude API side of Setup → AI model: which models the dropdown offers, what they cost, and
 * the output caps a run uses when Claude is the provider.
 *
 * Its own module because both ends need it — config-store.js renders the Setup card from it and
 * maps the token caps onto the run's environment, llm-client.js prices the usage it reports —
 * and neither of those should have to require the other.
 */

/** Stored key of the AI model card's switch: "openrouter" (default) or "anthropic". */
const LLM_PROVIDER_KEY = "LLM_PROVIDER";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Model id → price per million tokens (USD, Claude API first-party rates), for the cost shown in
 * the run log. The dropdown is built from the same table, in this order.
 */
const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", input: 4, output: 20, note: "recommended" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: 2, output: 10, note: "faster, cheaper" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", input: 0.1, output: 0.5, note: "fastest, cheapest" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", input: 10, output: 50, note: "most capable, slowest" },
  { id: "claude-opus-5", name: "Claude Opus 5", input: 5, output: 25, note: "previous Opus" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", input: 2, output: 10, note: "previous Sonnet" },
];

const fmtPrice = (n) => `$${n < 1 ? n.toFixed(2) : n}`;

/** Options for the Setup dropdown; the empty "default" entry is added by the page itself. */
const ANTHROPIC_MODEL_OPTIONS = ANTHROPIC_MODELS.map((m) => ({
  value: m.id,
  label: `${m.name} — ${fmtPrice(m.input)} / ${fmtPrice(m.output)}${m.note ? ` (${m.note})` : ""}`,
}));

/**
 * Output caps when Claude is the provider, used while the matching Setup field is empty. Higher
 * than the OpenRouter ones on purpose: current Claude models think before answering, and the
 * thinking counts towards max_tokens — a cap sized for the answer alone would cut it off.
 * A cap is a ceiling, not a charge: only tokens actually written are billed.
 */
const CLAUDE_TOKEN_CAP_DEFAULTS = {
  CLAUDE_TEST_CASES_MAX_TOKENS: 32000,
  CLAUDE_CHECKLIST_MAX_TOKENS: 32000,
  CLAUDE_BDD_MAX_TOKENS: 16000,
};

/**
 * Claude-side cap → the variable every generation script already reads. With Claude picked, the
 * run's environment gets the Claude values under the usual names, so no caller has to know which
 * provider is in use to find its cap.
 */
const CLAUDE_TOKEN_CAP_TARGETS = {
  CLAUDE_TEST_CASES_MAX_TOKENS: "TEST_CASES_MAX_TOKENS",
  CLAUDE_CHECKLIST_MAX_TOKENS: "CHECKLIST_MAX_TOKENS",
  CLAUDE_BDD_MAX_TOKENS: "ADO_SYNC_BDD_MAX_TOKENS",
};

/** "anthropic" when the Claude API is picked, else "openrouter" — the default and every unknown value. */
function llmProviderOf(env = process.env) {
  return String((env && env[LLM_PROVIDER_KEY]) || "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openrouter";
}

/** @returns {{ input: number, output: number } | null} USD per million tokens */
function anthropicPrice(modelId) {
  const id = String(modelId || "");
  const m = ANTHROPIC_MODELS.find((x) => id === x.id || id.startsWith(`${x.id}-`));
  return m ? { input: m.input, output: m.output } : null;
}

module.exports = {
  LLM_PROVIDER_KEY,
  DEFAULT_ANTHROPIC_MODEL,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_OPTIONS,
  CLAUDE_TOKEN_CAP_DEFAULTS,
  CLAUDE_TOKEN_CAP_TARGETS,
  llmProviderOf,
  anthropicPrice,
};
