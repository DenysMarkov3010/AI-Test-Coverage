/**
 * The one place that talks to OpenRouter.
 *
 * This used to be three copies — `callLLM` in agent-docs.js, `callLLM` in agent-update-csv.js and
 * `callOpenRouterForBdd` in ado-sync-csv.js — all doing the same thing: read OPENROUTER_MODELS,
 * walk the list with a fallback, retry twice on a retryable status, POST at temperature 0, return
 * `choices[0].message.content`.
 *
 * Being copies, every cross-cutting concern had to be fixed three separate times, and each time it
 * was found only after a user-visible failure: truncation detection (a completion stopped at the
 * cap arrives as a healthy 200 with a half-written body, which surfaced once as "LLM did not
 * return valid JSON" and once as "LLM response did not contain a Feature block"), token
 * accounting, and the progress heartbeat. The BDD caller never got token accounting at all, so the
 * run total silently excluded it.
 *
 * The callers really do differ, so the differences are options rather than something flattened
 * away: their token caps, their error wording (it is user-facing in the run log), whether they
 * announce the call, and how they obtain the API key.
 */

const { startHeartbeat } = require("./llm-progress");
const { addUsage } = require("./llm-usage");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b:free";
const DEFAULT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS_PER_MODEL = 2;
const RETRY_BASE_DELAY_MS = 1200;

/**
 * The model stopped at our cap, not at a natural end. Its own type so callers can tell it apart:
 * retrying at the same cap cannot produce a shorter answer, so it must not burn a retry or a
 * fallback model, and the message has to name the knob to turn.
 */
class LlmTruncatedError extends Error {
  constructor(message, { name = "LlmTruncatedError", maxTokens, model } = {}) {
    super(message);
    this.name = name;
    this.maxTokens = maxTokens;
    this.model = model;
  }
}

/** `OPENROUTER_MODELS` is a comma-separated list; the first is tried first, the rest are fallbacks. */
function parseModelList(raw) {
  return String(raw || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function resolveModels(models) {
  const list = Array.isArray(models) ? models.filter(Boolean) : parseModelList(process.env.OPENROUTER_MODELS);
  return list.length ? list : [DEFAULT_MODEL];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_LABELS = {
  apiKeyMissing: "OPENROUTER_API_KEY is not set",
  httpError: "LLM API error",
  noChoices: "LLM returned no choices",
  unknownFailure: "LLM failed with unknown error",
  truncationRemedy: "The answer is incomplete, so it cannot be parsed. Raise the token limit for this generation.",
};

/**
 * @param {string} prompt
 * @param {Object} options
 * @param {number} options.maxTokens - required; every caller has its own cap and its own default
 * @param {string} [options.apiKey] - defaults to OPENROUTER_API_KEY read at call time
 * @param {string[]} [options.models] - defaults to OPENROUTER_MODELS, then the free model
 * @param {Object} [options.usageTally] - from llm-usage.createUsageTally; token spend is folded in
 * @param {string} [options.heartbeatLabel] - suffix shown while waiting, defaults to the model id
 * @param {boolean} [options.announce=true] - print the "→ Asking / ← responded" pair
 * @param {boolean} [options.trimResult=false] - trim the returned content
 * @param {Set<number>} [options.retryableStatus]
 * @param {string} [options.truncationErrorName="LlmTruncatedError"]
 * @param {Partial<typeof DEFAULT_LABELS>} [options.labels] - user-facing wording, kept per caller
 * @param {{ onNoChoices?: Function, onModelSwitch?: Function, onFinalError?: Function }} [options.hooks]
 * @returns {Promise<string>} the completion text
 */
async function callOpenRouter(prompt, options = {}) {
  const {
    maxTokens,
    apiKey = process.env.OPENROUTER_API_KEY,
    models,
    usageTally = null,
    heartbeatLabel = "",
    announce = true,
    trimResult = false,
    retryableStatus = DEFAULT_RETRYABLE_STATUS,
    truncationErrorName = "LlmTruncatedError",
    hooks = {},
  } = options;
  const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };

  if (!maxTokens) throw new Error("callOpenRouter requires maxTokens");
  if (!apiKey) throw new Error(labels.apiKeyMissing);

  const fetchFn = globalThis.fetch || require("node-fetch");
  const modelList = resolveModels(models);
  let lastError = null;

  for (let modelIndex = 0; modelIndex < modelList.length; modelIndex += 1) {
    const model = modelList[modelIndex];
    const isLastModel = modelIndex === modelList.length - 1;

    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        // Without a tick the log goes silent for the whole call and the run looks stuck.
        if (announce) console.log(`   → Asking ${model} (max_tokens=${maxTokens})…`);
        const stopHeartbeat = startHeartbeat(heartbeatLabel || model);
        let res;
        try {
          res = await fetchFn(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              temperature: 0,
              max_tokens: maxTokens,
            }),
          });
        } finally {
          const seconds = stopHeartbeat();
          if (announce) console.log(`   ← ${model} responded after ${seconds}s`);
        }

        if (!res.ok) {
          const errorText = await res.text();
          lastError = new Error(`${labels.httpError}: ${res.status} ${res.statusText}. ${errorText}`);
          const retryable = retryableStatus.has(res.status);
          // All three original copies leaked a retry here: the throw below was caught by the
          // generic handler, which retried regardless of the status. A 401 or a 400 is not going
          // to succeed on a second identical POST, so mark it and let the handler skip it.
          lastError.retryableStatus = retryable;
          if (retryable && attempt < ATTEMPTS_PER_MODEL) {
            await delay(RETRY_BASE_DELAY_MS * attempt);
            continue;
          }
          if (retryable && !isLastModel) {
            if (hooks.onModelSwitch) hooks.onModelSwitch(model, "rate-limited/unavailable");
            break;
          }
          throw lastError;
        }

        const data = await res.json();
        if (!data.choices || !data.choices[0]) {
          if (hooks.onNoChoices) hooks.onNoChoices(data);
          throw new Error(labels.noChoices);
        }

        // Recorded before the truncation check: those tokens were billed either way, so losing
        // the accounting would understate what the run actually cost.
        if (usageTally) addUsage(usageTally, data.model || model, data.usage);

        const choice = data.choices[0];
        if (choice.finish_reason === "length" || choice.native_finish_reason === "length") {
          throw new LlmTruncatedError(
            `LLM output was cut off at max_tokens=${maxTokens} (model ${model}). ${labels.truncationRemedy}`,
            { name: truncationErrorName, maxTokens, model }
          );
        }

        const content = String(choice.message?.content || "");
        return trimResult ? content.trim() : content;
      } catch (error) {
        lastError = error;
        // The cap is ours, not the provider's — another attempt or another model changes nothing.
        if (error instanceof LlmTruncatedError) throw error;
        if (error && error.retryableStatus === false) throw error;
        if (attempt < ATTEMPTS_PER_MODEL) {
          await delay(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        if (!isLastModel) {
          if (hooks.onModelSwitch) hooks.onModelSwitch(model, error.message);
          break;
        }
      }
    }
  }

  const finalError = lastError || new Error(labels.unknownFailure);
  if (hooks.onFinalError) hooks.onFinalError(finalError);
  throw finalError;
}

module.exports = {
  callOpenRouter,
  LlmTruncatedError,
  parseModelList,
  OPENROUTER_URL,
  DEFAULT_MODEL,
  DEFAULT_RETRYABLE_STATUS,
};
