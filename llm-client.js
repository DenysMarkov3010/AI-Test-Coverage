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
const { DEFAULT_ANTHROPIC_MODEL, anthropicPrice, llmProviderOf } = require("./anthropic-models");

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
 * @param {string | Array<Object>} prompt - plain text, or OpenAI-style content parts
 *   (`{type:"text"}`, `{type:"image_url"}`, `{type:"file"}`) for a multimodal call — the attachment
 *   analyzer sends images and PDFs this way. Either goes into the single user message as-is.
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
 * @param {Object} [options.extraBody] - extra top-level request fields, e.g. OpenRouter `plugins`
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
    extraBody = null,
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
              ...(extraBody || {}),
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

/* ── Claude API (Anthropic) ─────────────────────────────────────────────────────────────────── */

/**
 * Models that take Anthropic's server-side refusal fallback. Their safety classifiers can decline
 * a benign request now and then; with `fallbacks: "default"` the API re-runs a declined request on
 * the model Anthropic recommends for that refusal category, inside the same call, instead of
 * failing the run. Claude Haiku 5.5 has no server-side fallback, so it is left out.
 */
const ANTHROPIC_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]);
const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Which provider Setup → AI model points at; read at call time, like the API keys. */
function activeLlmProvider() {
  return llmProviderOf(process.env);
}

function anthropicModel() {
  return String(process.env.ANTHROPIC_MODEL || "").trim() || DEFAULT_ANTHROPIC_MODEL;
}

/**
 * The provider's key, for callers that only want to know whether a model can be called at all
 * (the Figma and prototype vision passes skip themselves without one).
 */
function activeLlmApiKey() {
  return activeLlmProvider() === "anthropic" ? process.env.ANTHROPIC_API_KEY || "" : process.env.OPENROUTER_API_KEY || "";
}

/** "" when the provider in use has its key; otherwise the sentence to stop on. */
function missingLlmKeyMessage() {
  if (activeLlmApiKey()) return "";
  return activeLlmProvider() === "anthropic"
    ? "ANTHROPIC_API_KEY is not set (Setup → AI model → Claude API)"
    : "OPENROUTER_API_KEY is not set (Setup → AI model → OpenRouter)";
}

/**
 * The model a vision pass (Figma frames, prototype screenshots, attachments) will actually use:
 * with the Claude API, the Vision model picked on the Figma card, else the Setup → AI model one;
 * with OpenRouter, the model the caller resolved from its own settings.
 */
function activeVisionModel(openRouterModel) {
  if (activeLlmProvider() !== "anthropic") return openRouterModel;
  return String(process.env.CLAUDE_VISION_MODEL || "").trim() || anthropicModel();
}

/** `data:<mime>;base64,<data>` → its parts; null for an ordinary URL. */
function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(url || ""));
  return m ? { mediaType: m[1].toLowerCase(), data: m[2] } : null;
}

/**
 * Callers build their multimodal prompts in the OpenAI shape OpenRouter takes — `text`,
 * `image_url` (a data URL) and `file` (a PDF as a data URL). The Messages API wants `text`,
 * `image` and `document` blocks, so the prompt is translated here once instead of in every caller.
 */
function toAnthropicContent(prompt) {
  if (typeof prompt === "string") return prompt;
  return (Array.isArray(prompt) ? prompt : []).map((part) => {
    if (!part || part.type === "text") return { type: "text", text: String((part && part.text) || "") };
    if (part.type === "image_url") {
      const url = (part.image_url && part.image_url.url) || "";
      const inline = parseDataUrl(url);
      return inline
        ? { type: "image", source: { type: "base64", media_type: inline.mediaType, data: inline.data } }
        : { type: "image", source: { type: "url", url } };
    }
    if (part.type === "file") {
      const inline = parseDataUrl(part.file && part.file.file_data);
      if (inline && inline.mediaType === "application/pdf") {
        return { type: "document", source: { type: "base64", media_type: "application/pdf", data: inline.data } };
      }
      throw new Error(`Unsupported file for the Claude API: ${(part.file && part.file.filename) || "attachment"}`);
    }
    throw new Error(`Unsupported prompt part for the Claude API: ${part.type}`);
  });
}

/**
 * The usage of one Claude answer in the shape llm-usage.js folds in. Cache reads and writes count
 * as input tokens; the cost is computed from the published per-token prices of the model that
 * actually answered (a fallback can answer instead of the one asked for).
 */
function anthropicUsage(message) {
  const u = (message && message.usage) || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens || 0;
  const price = anthropicPrice(message && message.model);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(price ? { cost: (input * price.input + output * price.output) / 1e6 } : {}),
  };
}

let anthropicClient = null;
let anthropicClientKey = "";
function anthropicClientFor(apiKey) {
  if (!anthropicClient || anthropicClientKey !== apiKey) {
    const Anthropic = require("@anthropic-ai/sdk");
    const Ctor = Anthropic.default || Anthropic;
    // The SDK retries 408 / 409 / 429 / 5xx and connection errors itself (with backoff and
    // retry-after); the answer streams, so a long one does not run into the timeout.
    anthropicClient = new Ctor({ apiKey, maxRetries: 3, timeout: 20 * 60 * 1000 });
    anthropicClientKey = apiKey;
  }
  return anthropicClient;
}

/**
 * The Claude API twin of callOpenRouter: same options, same return value, same errors, so a
 * caller does not care which one runs (see callModel). One model — Setup → AI model → Model — and
 * no model list to walk: retries are the SDK's, and a refusal is handled server-side.
 *
 * `apiKey`, `models` and `extraBody` are OpenRouter's and are ignored here; `anthropicModel`
 * overrides the Setup → AI model one for this call. Thinking is left at the
 * model's default (adaptive, on), which is why max_tokens has to leave room for it.
 *
 * @returns {Promise<string>} the answer text
 */
async function callAnthropic(prompt, options = {}) {
  const {
    maxTokens,
    usageTally = null,
    heartbeatLabel = "",
    announce = true,
    trimResult = false,
    truncationErrorName = "LlmTruncatedError",
    hooks = {},
  } = options;
  const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };

  if (!maxTokens) throw new Error("callAnthropic requires maxTokens");
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Setup → AI model → Claude API)");

  // A vision pass names its own Claude model (activeVisionModel); everything else uses the main one.
  const model = options.anthropicModel || anthropicModel();
  const client = anthropicClientFor(apiKey);
  const withFallback = ANTHROPIC_FALLBACK_MODELS.has(model);

  if (announce) console.log(`   → Asking ${model} via the Claude API (max_tokens=${maxTokens})…`);
  const stopHeartbeat = startHeartbeat(heartbeatLabel || model);
  let message;
  try {
    // Streamed, then collected: an answer with tens of thousands of tokens would otherwise hit the
    // HTTP timeout. No temperature: current Claude models reject sampling parameters.
    const params = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: toAnthropicContent(prompt) }],
      ...(withFallback ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: "default" } : {}),
    };
    const stream = withFallback ? client.beta.messages.stream(params) : client.messages.stream(params);
    message = await stream.finalMessage();
  } catch (error) {
    const status = error && error.status ? ` ${error.status}` : "";
    const finalError = new Error(`${labels.httpError}:${status} ${(error && error.message) || error}`.trim());
    if (hooks.onFinalError) hooks.onFinalError(finalError);
    throw finalError;
  } finally {
    const seconds = stopHeartbeat();
    if (announce) console.log(`   ← ${model} responded after ${seconds}s`);
  }

  // Billed whether or not the answer is usable, so it is counted first.
  if (usageTally) addUsage(usageTally, message.model || model, anthropicUsage(message));
  if (message.model && message.model !== model) {
    console.log(`   ↪ ${model} declined; answered by ${message.model} (server-side fallback)`);
  }

  if (message.stop_reason === "refusal") {
    const d = message.stop_details || {};
    const finalError = new Error(
      `Claude declined the request${d.category ? ` (category: ${d.category})` : ""}${d.explanation ? ` — ${d.explanation}` : ""}. ` +
        "Try again, rephrase the helping prompt / guidance, or pick another model on Setup → AI model."
    );
    if (hooks.onFinalError) hooks.onFinalError(finalError);
    throw finalError;
  }
  if (message.stop_reason === "max_tokens") {
    throw new LlmTruncatedError(
      `LLM output was cut off at max_tokens=${maxTokens} (model ${message.model || model}; Claude's thinking counts towards this cap). ${labels.truncationRemedy}`,
      { name: truncationErrorName, maxTokens, model: message.model || model }
    );
  }

  const content = (message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!content.trim()) {
    if (hooks.onNoChoices) hooks.onNoChoices(message);
    throw new Error(labels.noChoices);
  }
  return trimResult ? content.trim() : content;
}

/**
 * Call whichever provider Setup → AI model points at. Every caller goes through here; the options
 * are callOpenRouter's, and the Claude path ignores the OpenRouter-only ones (key, model list,
 * request extras) in favour of ANTHROPIC_API_KEY / ANTHROPIC_MODEL.
 */
function callModel(prompt, options = {}) {
  return activeLlmProvider() === "anthropic" ? callAnthropic(prompt, options) : callOpenRouter(prompt, options);
}

module.exports = {
  callModel,
  callOpenRouter,
  callAnthropic,
  activeLlmProvider,
  activeLlmApiKey,
  activeVisionModel,
  anthropicModel,
  missingLlmKeyMessage,
  toAnthropicContent,
  LlmTruncatedError,
  parseModelList,
  OPENROUTER_URL,
  DEFAULT_MODEL,
  DEFAULT_RETRYABLE_STATUS,
};
