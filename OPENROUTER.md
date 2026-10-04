# OpenRouter in this project

This document explains **what OpenRouter is**, **why** the QA agent uses it, and **how to switch models** via environment variables.

---

## What is OpenRouter?

[OpenRouter](https://openrouter.ai) is a **single API gateway** to **hundreds of LLMs** from different providers (Anthropic, OpenAI, Google, Meta, Qwen, and others). You get one account and one API key, and you send requests to an **OpenAI-compatible** endpoint:

`https://openrouter.ai/api/v1/chat/completions`

Request and response shapes match **Chat Completions** (`model`, `messages`, `temperature`, `max_tokens`, and so on), so integrations can be moved between providers by changing mainly the **model ID** and base URL.

Official docs: [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart). Full documentation index: [openrouter.ai/docs/llms.txt](https://openrouter.ai/docs/llms.txt).

---

## Why OpenRouter in this repository

The LLM is used to generate **checklists** and **test cases** from Jira issue descriptions (see `agent-docs.js` and `agent-update-csv.js`).

Why OpenRouter fits this workflow:

- **One key** (`OPENROUTER_API_KEY`) instead of separate accounts per vendor.
- A **model catalog** with pricing, context windows, and limits: [Models](https://openrouter.ai/models).
- You can start with **free or cheaper** models and move up in quality when needed.
- The code implements a **candidate list with fallback**: if a model is unavailable or returns errors such as rate limits, the agent **automatically tries the next** model in the list.

---

## Setup: API key

1. Sign up at [openrouter.ai](https://openrouter.ai) and create an API key (often prefixed with `sk-or-v1-...`).
2. Paste it into **OpenRouter API key** on the Setup page, under **AI model (OpenRouter)**, and save.
   It is stored in `config.local.json`, which is git-ignored.
3. Do not share the key publicly.

---

## Choosing and using different models

### Where to find model IDs

- Interactive catalog: [openrouter.ai/models](https://openrouter.ai/models).
- Each model page shows the **exact ID** (for example `anthropic/claude-sonnet-4.5`) to pass in the `model` field.

### ID format

Usually **`provider/model-name`**, for example:

- `anthropic/claude-sonnet-4.5`
- `openai/gpt-4o`
- `google/gemini-2.0-flash-001`

Some models use a **`:free`** suffix (free tier with limits). See the OpenRouter [FAQ on rate limits](https://openrouter.ai/docs/faq#how-are-rate-limits-calculated).

### Configuration in this project: `OPENROUTER_MODELS`

In the **Models** field of the same Setup card, set a **comma-separated** ordered list. The **first** model is tried first; on failure the agent moves to the **next**:

```env
OPENROUTER_MODELS=anthropic/claude-sonnet-4.5,google/gemini-2.0-flash-001,openai/gpt-oss-20b:free
```

Notes:

- Spaces around commas are optional: values are trimmed with `.trim()`.
- Order matters: this is **priority**, not parallel calls.

If `OPENROUTER_MODELS` is **unset**, both `agent-docs.js` and `agent-update-csv.js` default to a single model: `openai/gpt-oss-20b:free`. Set `OPENROUTER_MODELS` explicitly when you want a different model or a fallback chain.

### Picking a model for the task

| Goal | Practical tip |
|------|----------------|
| Best writing quality and test-design structure | Stronger paid models from the catalog (Claude, GPT-4o / GPT-5.x, Gemini Pro, and so on)—check ratings and price on [Models](https://openrouter.ai/models). |
| Cost saving or integration smoke tests | `:free` models or cheaper tiers; watch rate limits. |
| Long outputs (many test-case steps) | Check **context length** on the model card; this repo also has **Max tokens per generation** (`TEST_CASES_MAX_TOKENS`) on the Setup page. |

The openrouter.ai catalog changes over time: **always copy the current ID** from the model page instead of relying on outdated names from examples or chats.

---

## Optional OpenRouter headers

OpenRouter docs mention optional `HTTP-Referer` and `X-OpenRouter-Title` headers for **app attribution** on site leaderboards. The agent code in this repo **does not send** them; the API still works. If you add them in a fork, follow [App Attribution](https://openrouter.ai/docs/app-attribution).

---

## Quick checklist

1. Set the OpenRouter API key on the Setup page.
2. Optionally fill **Models** (`OPENROUTER_MODELS`) with a comma-separated list from [Models](https://openrouter.ai/models).
3. Ensure your OpenRouter balance covers **paid** models; for **`:free`**, respect the FAQ limits.

Then run `node agent-docs.js` or the updated-CSV flow described in **FULL_FLOW_GUIDE.md**.
