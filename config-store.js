/**
 * Local configuration store — the UI-editable replacement for a hand-edited `.env`.
 *
 * Everything the agent needs (Jira / OpenRouter / Azure DevOps / Figma / ...) is
 * described by SECTIONS below and persisted as JSON in `config.local.json`
 * (git-ignored, chmod 600). The Setup page in the web UI renders itself from
 * that same schema, so a new setting is added in exactly one place: here.
 *
 * Env precedence, applied by loadEnv():
 *
 *   real shell env (incl. per-run overrides a parent process injected)
 *     > config.local.json   (what the user typed on the Setup page)
 *       > .env              (legacy fallback, still honoured if present)
 *
 * dotenv never overwrites keys that already exist, so simply applying the
 * store before calling it produces that order for free.
 */
const fs = require("fs");
const path = require("path");
const {
  LLM_PROVIDER_KEY,
  DEFAULT_ANTHROPIC_MODEL,
  ANTHROPIC_MODEL_OPTIONS,
  CLAUDE_TOKEN_CAP_DEFAULTS,
  CLAUDE_TOKEN_CAP_TARGETS,
  llmProviderOf,
} = require("./anthropic-models.js");

/**
 * Pristine copy of the environment as the process was started. Captured at
 * first require — entry scripts require this module before anything mutates
 * process.env — so childEnv() can rebuild a clean env instead of inheriting
 * values that an earlier, now-edited config had injected.
 */
const SHELL_ENV = Object.freeze({ ...process.env });

const STORE_PATH = path.join(__dirname, "config.local.json");
const DOTENV_PATH = path.join(__dirname, ".env");

/** Sent by the UI in place of a secret to mean "keep the stored value". */
const KEEP_SECRET = "__KEEP__";

const BOOL_OPTIONS = [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
];

/**
 * For switches the QA engineer answers as a question rather than sets as a flag.
 * Stored verbatim, so the value read back from the environment is "yes" / "no".
 */
const YES_NO_OPTIONS = [
  { value: "yes", label: "yes" },
  { value: "no", label: "no" },
];

/**
 * Which field TestRail keeps a case's steps in. `auto` reads the project's
 * template once and picks whichever field exists — the right answer on a
 * stock instance. The explicit values are the escape hatch for an instance
 * that renamed or dropped one of them.
 */
const TESTRAIL_STEPS_FIELD_OPTIONS = [
  { value: "auto", label: "auto (read the template)" },
  { value: "custom_steps_separated", label: "custom_steps_separated (Steps template)" },
  { value: "custom_steps", label: "custom_steps (plain Text template)" },
];

/**
 * Config schema. Each section becomes one card on the Setup page.
 *
 *   group    — which block of the page the card lives in
 *   test     — id of a live connection test (see testConnection())
 *   planned  — integration not built yet: rendered as a disabled card
 *   fields[].required — must be filled for the section to read "Configured"
 */
const SECTIONS = [
  {
    id: "jira",
    title: "Jira",
    group: "core",
    // `icon` stays as the fallback renderCardIcon() swaps back in if the file ever goes missing.
    icon: "\u{1F9E9}",
    iconSrc: "/assets/jira.svg",
    hint: "Source of tickets, descriptions and comments. Token: Atlassian account → Security → API tokens.",
    test: "jira",
    fields: [
      {
        key: "JIRA_BASE_URL",
        label: "Jira base URL",
        type: "url",
        required: true,
        placeholder: "https://yourcompany.atlassian.net",
        hint: "No trailing slash.",
      },
      {
        key: "JIRA_EMAIL",
        label: "Jira account email",
        type: "text",
        required: true,
        placeholder: "you@company.com",
      },
      {
        key: "JIRA_API_TOKEN",
        label: "Jira API token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "Paste the API token",
      },
      {
        key: "JIRA_PROJECT_KEY",
        label: "Default project key",
        type: "text",
        placeholder: "PROJ",
        hint: "Pre-fills the Jira key on the Create, Update and Cover a bug pages (PROJ-), so only the number is left to type. Also the project the related-issues search runs in.",
      },
      // The related-issues search keeps its defaults (Story, Improvement; reuse of neighbouring
      // checklists on) — RELATED_ISSUES_TYPES / ENABLE_RELATED_CHECKLISTS still work from .env.
    ],
  },
  {
    id: "ai",
    title: "AI model",
    group: "core",
    icon: "\u{1F916}",
    hint: "Generates checklists, test cases and BDD, and reads designs, prototypes and attached files. Pick where the model runs: OpenRouter (key: openrouter.ai/keys) or the Claude API directly (key: platform.claude.com → API Keys). Only the provider picked here is used; the other one's settings are kept for when you switch back.",
    // One "Test connection" button; testConnection() checks whichever provider is picked.
    test: "ai",
    fields: [
      {
        // Rendered as a two-option switch at the top of the card. Every other field of the card
        // carries a `variant` and is shown — and required — only while its provider is picked.
        key: LLM_PROVIDER_KEY,
        label: "Provider",
        type: "toggle",
        default: "openrouter",
        options: [
          { value: "openrouter", label: "OpenRouter" },
          { value: "anthropic", label: "Claude API" },
        ],
        hint: "OpenRouter routes to many models with one key. Claude API calls Anthropic directly and bills the API key's own workspace and limits.",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API key",
        type: "password",
        required: true,
        secret: true,
        variant: "openrouter",
        placeholder: "sk-or-v1-...",
      },
      {
        key: "OPENROUTER_MODELS",
        label: "Models",
        type: "text",
        variant: "openrouter",
        placeholder: "anthropic/claude-sonnet-4.5,openai/gpt-oss-20b:free",
        hint: "Comma-separated; the first one is tried first, the rest are fallbacks.",
      },
      {
        key: "TEST_CASES_MAX_TOKENS",
        label: "Max tokens per test-case generation",
        type: "number",
        variant: "openrouter",
        placeholder: "12000",
        hint: "Output cap for test cases. Too low and the answer is cut off mid-JSON.",
      },
      {
        key: "ADO_SYNC_BDD_MAX_TOKENS",
        label: "Max tokens per BDD description",
        type: "number",
        variant: "openrouter",
        placeholder: "4000",
        // Named for Azure DevOps, and only the Azure DevOps importer reads it: the
        // others make no LLM call during the import.
        hint: "Output cap for the generated Gherkin Description of an Azure DevOps Test Case (Azure DevOps only).",
      },
      {
        key: "CHECKLIST_MAX_TOKENS",
        label: "Max tokens per checklist generation",
        type: "number",
        variant: "openrouter",
        placeholder: "12000",
        hint: "Output cap for checklists. A full checklist runs 16-27 items, so keep this generous.",
      },
      {
        key: "ANTHROPIC_API_KEY",
        label: "Claude API key",
        type: "password",
        required: true,
        secret: true,
        variant: "anthropic",
        placeholder: "sk-ant-api03-...",
        hint: "An API key from the Claude Console (platform.claude.com → API Keys). A Claude.ai / Claude for Work subscription has no API key and cannot be used here.",
      },
      {
        key: "ANTHROPIC_MODEL",
        label: "Model",
        type: "select",
        variant: "anthropic",
        placeholder: DEFAULT_ANTHROPIC_MODEL,
        options: ANTHROPIC_MODEL_OPTIONS,
        hint: "Used for every call: generation, regeneration, requirement analysis, and reading designs, prototypes and attachments (every Claude model reads images and PDFs). Prices are per million input / output tokens.",
      },
      {
        key: "CLAUDE_TEST_CASES_MAX_TOKENS",
        label: "Max tokens per test-case generation",
        type: "number",
        variant: "anthropic",
        placeholder: String(CLAUDE_TOKEN_CAP_DEFAULTS.CLAUDE_TEST_CASES_MAX_TOKENS),
        hint: "Output cap for test cases. Claude thinks before it answers and the thinking counts towards this cap, so it needs more room than on OpenRouter. If the run log says the answer was cut off, raise it — you pay only for tokens actually written.",
      },
      {
        key: "CLAUDE_BDD_MAX_TOKENS",
        label: "Max tokens per BDD description",
        type: "number",
        variant: "anthropic",
        placeholder: String(CLAUDE_TOKEN_CAP_DEFAULTS.CLAUDE_BDD_MAX_TOKENS),
        hint: "Output cap for the generated Gherkin Description of an Azure DevOps Test Case (Azure DevOps only). Thinking counts towards it.",
      },
      {
        key: "CLAUDE_CHECKLIST_MAX_TOKENS",
        label: "Max tokens per checklist generation",
        type: "number",
        variant: "anthropic",
        placeholder: String(CLAUDE_TOKEN_CAP_DEFAULTS.CLAUDE_CHECKLIST_MAX_TOKENS),
        hint: "Output cap for checklists. Thinking counts towards it, so keep it generous.",
      },
      // ENABLE_TEST_CASES_ANALYSIS intentionally has no Setup field: the create
      // page owns it per run ("Analyze existing test cases", default Yes).
    ],
  },

  // ── Test management providers ───────────────────────────────────────────
  // `provider: true` puts the "In use" toggle in the card header: every
  // provider can be configured, exactly one is the active target for a run
  // (see ACTIVE_PROVIDER_KEY / activeProvider()). All three are configurable
  // and testable here; only the ones with a CSV importer can actually receive
  // an approved run (see TMS_IMPORTERS in agent-docs.js).
  {
    // The "Analyze requirements" page (requirements-analysis.js). No required fields: it works
    // with the default; the card is here so the output budget can be tuned without a .env.
    id: "analyze",
    title: "Analyze requirements",
    group: "analysis",
    icon: "\u{1F50E}",
    hint: "The grooming helper on the Analyze requirements page: questions, gaps, differences between sources and ISO/IEC/IEEE 29148 findings for one ticket.",
    fields: [
      {
        key: "ANALYZE_MAX_TOKENS",
        label: "Max tokens per analysis",
        type: "number",
        placeholder: "16000",
        hint: "Output cap for one analysis. A big ticket with many sources needs more; if the run log says the answer was cut off, raise it. Higher values cost more only when the model actually writes that much.",
      },
    ],
  },
  {
    id: "examples",
    title: "Format examples",
    group: "generation",
    icon: "\u{1F4D0}",
    hint: "Worked examples of the house style: test cases, checklists and BDD scenarios. The model is shown them as the shape to follow, so their step granularity, wording and expected-result depth set the style of everything it generates — whichever test management system is In use. Test cases and checklists go to the standard prompt, BDD scenarios to the Gherkin one. Stored locally in test-case-examples.local.json; they go nowhere but the generation prompt.",
    // No config values: the card is the examples editor. Every change saves over its own
    // endpoint — see examples-store.js and renderExamplesPanel() in web/setup-app.js.
    panel: "examples",
    fields: [],
  },
  {
    id: "ado",
    title: "Azure DevOps",
    group: "testmgmt",
    // `icon` is the fallback the browser falls back to if the image 404s.
    icon: "\u{1F537}",
    iconSrc: "/assets/tms/azure-devops.png",
    provider: true,
    hint: "Where generated test cases are imported, and where Test Plans / Suites are read from.",
    test: "ado",
    docs: { href: "/ADO_TEST_PLANS.md", label: "ADO_TEST_PLANS.md" },
    fields: [
      {
        key: "ADO_ORG",
        label: "Organization",
        type: "text",
        required: true,
        placeholder: "your-org-name",
        hint: "The segment right after dev.azure.com/.",
      },
      {
        key: "ADO_PROJECT",
        label: "Project",
        type: "text",
        required: true,
        placeholder: "YourProjectName",
      },
      {
        key: "ADO_PAT",
        label: "Personal Access Token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "Paste the PAT",
        hint: "Scopes: Test Management (read & write), Work Items (read & write).",
      },
      {
        key: "ADO_ACTIVE_TEST_PLAN_ID",
        label: "Active Test Plan",
        // Picked from the live plan list once the PAT is in place; the stored
        // value is still the plan id, which is what every script consumes.
        type: "remote-select",
        remote: {
          list: "ado-test-plans",
          needs: ["ADO_ORG", "ADO_PROJECT", "ADO_PAT"],
          missing: "Add organization, project and PAT to load Test Plans",
          reload: "Re-read the Test Plan list from Azure DevOps",
          empty: "Select a plan",
          unknown: "Plan {value} (not in this project)",
        },
        required: true,
        hint: "Plan that receives newly generated test cases.",
      },
      // No Area Path, Area Path prefix or Server URL here on purpose: the CSV's own "Area Path"
      // column is used verbatim (empty = the project root), and dev.azure.com is the host. The
      // env vars (ADO_DEFAULT_AREA_PATH, ADO_AREA_PATH_PREFIX, ADO_SERVER_URL) still work from .env.
      {
        key: "ADO_SYNC_BDD_FROM_PROMPT",
        label: "Fill Summary with generated BDD",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
        hint: "Costs one extra LLM call per imported test case.",
      },
      {
        key: "PROTOTYPE_READ",
        label: "Read prototype",
        type: "select",
        options: YES_NO_OPTIONS,
        placeholder: "no",
        hint: "For the designer's clickable design prototypes deployed to Netlify (https://your-prototype.netlify.app/) \u2014 the running prototype, not the Figma file. Yes adds a \"Prototype link\" field to Create and Update test design. A link put there is opened in a headless browser before generation: every screen the app's router exposes is rendered, its labels, fields and messages are read, and the first few are shown to a vision model \u2014 so the design the tests are written against is the running build, not a guess. Costs about a minute per run. No hides the field and changes nothing else.",
      },
      {
        // Not a setting: shows which vision model reads the prototype screenshots. It follows the
        // Vision model on the Figma card (and the provider picked on Setup → AI model) by itself.
        key: "PROTOTYPE_VISION_MODEL_VIEW",
        label: "Prototype vision model",
        type: "mirror",
        mirror: {
          openrouter: { keys: ["FIGMA_VISION_MODEL"], fallback: "google/gemini-2.5-flash" },
          anthropic: { keys: ["CLAUDE_VISION_MODEL", "ANTHROPIC_MODEL"], fallback: DEFAULT_ANTHROPIC_MODEL },
        },
        hint: "Set automatically: the Vision model of the Figma card (with the Claude API, the Claude vision model there, else the model on Setup → AI model). Change it on the Figma card.",
      },
    ],
  },
  {
    id: "testrail",
    title: "TestRail",
    group: "testmgmt",
    icon: "\u{1F7E5}",
    iconSrc: "/assets/tms/testrail.png",
    provider: true,
    test: "testrail",
    // Azure DevOps links a work item into a Plan/Suite; TestRail stores a case
    // inside a Section of a Suite, and Runs/Plans are a separate execution
    // layer this flow never touches. The section is deliberately *not* a field:
    // it is resolved per ticket at import time, the way the Azure DevOps suite
    // is, so nobody has to revisit this page between tickets.
    hint: "Where generated test cases are imported: Project → Suite of the case repository. The section inside that suite is picked per ticket from the Jira key, so it is not a setting here. Enable the API first in Administration → Site Settings → API. Mark it In use to import approved test cases here.",
    docs: { href: "/TESTRAIL.md", label: "TESTRAIL.md" },
    fields: [
      {
        key: "TESTRAIL_BASE_URL",
        label: "Instance URL",
        type: "url",
        required: true,
        placeholder: "https://yourcompany.testrail.io",
        hint: "No trailing slash. A pasted /index.php?/api/v2 suffix is stripped automatically.",
      },
      {
        key: "TESTRAIL_EMAIL",
        label: "Account email",
        type: "text",
        required: true,
        placeholder: "you@company.com",
        hint: "The login email of the account the API key belongs to.",
      },
      {
        key: "TESTRAIL_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        secret: true,
        placeholder: "Paste the API key",
        hint: "TestRail → My Settings → API Keys. An account password works only on instances that still allow it.",
      },
      {
        key: "TESTRAIL_PROJECT_ID",
        label: "Project",
        type: "remote-select",
        required: true,
        remote: {
          list: "testrail-projects",
          needs: ["TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY"],
          missing: "Add instance URL, email and API key to load projects",
          reload: "Re-read the project list from TestRail",
          empty: "Select a project",
          unknown: "Project {value} (not visible to this account)",
        },
      },
      {
        key: "TESTRAIL_SUITE_ID",
        label: "Suite",
        type: "remote-select",
        // Required because get_sections rejects a multi-suite project without
        // one, and the import reads that tree on every run to find the ticket's
        // section. A single-suite project has exactly one, and the picker fills
        // that in by itself — see autoSelectSoleOption() in setup-app.js.
        required: true,
        remote: {
          list: "testrail-suites",
          needs: ["TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY", "TESTRAIL_PROJECT_ID"],
          dependsOn: ["TESTRAIL_PROJECT_ID"],
          missing: "Pick a project first",
          reload: "Re-read the suite list from TestRail",
          empty: "Select a suite",
          unknown: "Suite {value} (not in this project)",
        },
        hint: "Only multi-suite projects (suite_mode 3) have more than one. A single-suite project offers its one suite here. Sections inside it are matched per ticket, not chosen here.",
      },
      {
        key: "TESTRAIL_TEMPLATE_ID",
        label: "Template",
        type: "remote-select",
        remote: {
          list: "testrail-templates",
          needs: ["TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY", "TESTRAIL_PROJECT_ID"],
          dependsOn: ["TESTRAIL_PROJECT_ID"],
          missing: "Pick a project first",
          reload: "Re-read the template list from TestRail",
          empty: "default template",
          unknown: "Template {value}",
        },
        hint: 'Decides where steps go: "Test Case (Steps)" keeps them separated, the plain template stores one text block. Empty = the project default.',
      },
      {
        key: "TESTRAIL_TYPE_ID",
        label: "Case type",
        type: "remote-select",
        remote: {
          list: "testrail-case-types",
          needs: ["TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY"],
          missing: "Add instance URL, email and API key to load case types",
          reload: "Re-read the case types from TestRail",
          empty: "default type",
          unknown: "Type {value}",
        },
        hint: "Empty = the instance default, usually Functional.",
      },
      {
        key: "TESTRAIL_STEPS_FIELD",
        label: "Steps field",
        type: "select",
        options: TESTRAIL_STEPS_FIELD_OPTIONS,
        placeholder: "auto",
        hint: "Leave on auto unless this instance renamed its step fields.",
      },
      {
        key: "TESTRAIL_CREATE_MISSING_SECTION",
        label: "Create the section when missing",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
        hint: "Cases land in the section whose name carries the ticket key (PROJ-123), the way the Azure DevOps suite is matched. On: a missing one is created at the root of the suite. Off: the import stops and says which key found nothing, rather than filing cases somewhere arbitrary.",
      },
    ],
  },
  {
    id: "zephyr",
    title: "Zephyr Essential",
    group: "testmgmt",
    icon: "\u{1F7E9}",
    iconSrc: "/assets/tms/zephyr-essential.png",
    provider: true,
    test: "zephyr",
    // Essential 2.0 stores its own test cases, addressed by project key and
    // filed in a folder tree — so unlike 1.0, where a test was a Jira issue,
    // this card needs no Jira credentials at all. Four fields: who we are,
    // where cases go, and whether a run imports.
    //
    // The folder picked here is the root the import files under; the
    // per-ticket folder inside it is matched from the Jira key at import time,
    // the way the Azure DevOps suite and the TestRail section are, so it is
    // not a setting.
    hint: "Where generated test cases are imported: a Zephyr project, then the folder of its test-case tree. The token comes from the Jira profile menu → Zephyr Essential API Access Tokens and carries the identity, so there is no email field. This card is for Zephyr Essential 2.0 (New Experience) — the version whose tokens live under your profile. The 1.0 Legacy Experience signs requests with an access key + secret key pair from Apps → Zephyr Squad → API Keys, which is a different API and is not wired up. Mark it In use to import approved test cases here.",
    docs: { href: "/ZEPHYR.md", label: "ZEPHYR.md" },
    fields: [
      {
        key: "ZEPHYR_API_TOKEN",
        label: "API token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "Paste the access token",
        hint: "In Jira: your profile picture → Zephyr Essential API Access Tokens → Create access token. Copy the value it shows once — the UUID left behind in the list afterwards is the token's ID, for revoking it, not the token. Tokens expire, so a 401 on one that worked last month means it has to be recreated.",
      },
      {
        key: "ZEPHYR_PROJECT_KEY",
        label: "Project",
        // Stores the project KEY (PROJ), not an id: every Zephyr read is scoped
        // by `projectKey`. The list only ever shows keys because Zephyr's
        // /projects endpoint carries no display name.
        type: "remote-select",
        required: true,
        remote: {
          list: "zephyr-projects",
          needs: ["ZEPHYR_API_TOKEN"],
          missing: "Add the API token to load projects",
          reload: "Re-read the project list from Zephyr",
          empty: "Select a project",
          unknown: "Project {value} (not enabled for Zephyr)",
        },
        hint: "Only projects Zephyr Essential is switched on for appear here. The list shows keys alone — that endpoint carries no project name, so the Jira project id is in the tooltip to tell similar keys apart.",
      },
      {
        key: "ZEPHYR_CREATE_MISSING_FOLDER",
        label: "Create the folder when missing",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
        hint: "Cases land in the folder whose name carries the ticket key (PROJ-123), the way the TestRail section and the Azure DevOps suite are matched. On: a missing one is created at the root of the project, named \"PROJ-123 Story summary\". Off: the import stops and says which key found nothing, rather than filing cases somewhere arbitrary.",
      },
    ],
  },
  {
    id: "xray",
    title: "Xray",
    group: "testmgmt",
    icon: "\u{1F52C}",
    iconSrc: "/assets/tms/xray.png",
    provider: true,
    test: "xray",
    // Xray is a Jira app, so a Test is a Jira issue and the project here is a Jira project key.
    // The credentials are not the Jira ones: Xray issues its own API key pair, and that pair buys
    // a 24h token. Four fields, same shape as the sibling cards: who we are, where tests go, and
    // whether a run imports.
    hint: "Where generated test cases are imported: a Jira project with Xray enabled, and a folder of its Test Repository. The Client ID and Client Secret come from Jira → Apps → Xray → API Keys — they are Xray's own credentials, not your Jira token. A created test is a Jira issue of type Test, labelled with the ticket it covers.",
    docs: { href: "/XRAY.md", label: "XRAY.md" },
    fields: [
      {
        key: "XRAY_CLIENT_ID",
        label: "Client ID",
        type: "text",
        required: true,
        placeholder: "The API key's Client ID",
        hint: "In Jira: Apps → Xray → API Keys → create a key for a user who may create issues in the project. The pair is shown once.",
      },
      {
        key: "XRAY_CLIENT_SECRET",
        label: "Client Secret",
        type: "password",
        required: true,
        secret: true,
        placeholder: "The API key's Client Secret",
        hint: "The other half of the same API key. Together they buy a bearer token that lasts 24 hours; this project renews it by itself.",
      },
      {
        key: "XRAY_PROJECT_KEY",
        label: "Jira project key",
        type: "text",
        required: true,
        placeholder: "PROJ",
        hint: "The project the Test issues are created in. It must have Xray enabled; empty falls back to the Jira card's project key.",
      },
      {
        key: "XRAY_FOLDER_PATH",
        label: "Test Repository folder",
        // A picker rather than a typed path: the tree is readable as soon as the keys and the
        // project are in, and a mistyped path is a folder nobody notices is wrong until the
        // repository has tests in two places. The root is preselected because "/" is where Xray
        // itself files a test when nothing else is said.
        type: "remote-select",
        remote: {
          list: "xray-folders",
          needs: ["XRAY_CLIENT_ID", "XRAY_CLIENT_SECRET", "XRAY_PROJECT_KEY"],
          dependsOn: ["XRAY_PROJECT_KEY"],
          preselect: "/",
          missing: "Add the API key pair and the project key to load folders",
          reload: "Re-read the Test Repository from Xray",
          empty: "Test Repository (root)",
          unknown: "{value} (not in this repository)",
        },
        hint: "The root a run files under. \"/\" is the repository root, and it is what this picks by itself once the fields above are filled. The per-ticket folder inside it is matched from the Jira key at import time, the way the Azure DevOps suite and the TestRail section are \u2014 so only the root is chosen here. A folder has to exist in Xray to be picked; the ones under it are created by the import.",
      },
      {
        key: "XRAY_CREATE_MISSING_FOLDER",
        label: "Create the folder when missing",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
        hint: "Tests land in the Test Repository folder whose name carries the ticket key, the way the Azure DevOps suite and the TestRail section are matched. On: a missing one is created under the root above, named \"PROJ-123 Story summary\". Off: everything files at that root instead \u2014 no run ever fails over a folder, because the tests themselves are the point.",
      },
      {
        key: "XRAY_LINK_ISSUES",
        label: "Link tests to the ticket",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
        hint: "An Xray test is a Jira issue, so it can carry a real issue link back to the story rather than only a label. Needs the Jira credentials this card resolves the project id with. A link that fails is reported and the test is kept \u2014 the test is what was approved.",
      },
    ],
  },

  // ── Optional context sources ────────────────────────────────────────────
  {
    id: "confluence",
    title: "Confluence",
    group: "sources",
    icon: "\u{1F4DA}",
    iconSrc: "/assets/confluence.svg",
    // Green "Configured" only once the search is actually switched on.
    enabledBy: "ENABLE_CONFLUENCE_SEARCH",
    hint: "Extra requirements context pulled from Confluence pages: the links in the Jira description, and the Confluence link field that true adds to Create and Update test design. Reuses the Jira credentials; the Confluence host is taken from each link.",
    fields: [
      {
        key: "ENABLE_CONFLUENCE_SEARCH",
        label: "Search Confluence",
        type: "select",
        required: true,
        options: BOOL_OPTIONS,
        placeholder: "false",
      },
      // CONFLUENCE_BASE_URL is no longer a field here: page links are typed per run on the
      // Create / Update pages and carry their own host. It stays a (hidden) schema key in
      // META_FIELDS so a value saved earlier is kept and still exported.
    ],
  },
  {
    id: "figma",
    title: "Figma",
    group: "sources",
    icon: "\u{1F3A8}",
    iconSrc: "/assets/figma.svg",
    hint: "Reads design frames (optionally as images) referenced by a ticket. Token: Figma → Settings → Personal access tokens.",
    test: "figma",
    fields: [
      {
        key: "FIGMA_TOKEN",
        label: "Figma token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "figd_...",
      },
      {
        key: "FIGMA_INCLUDE_VISION",
        label: "Analyze frames as images",
        type: "select",
        options: BOOL_OPTIONS,
        placeholder: "true",
      },
      {
        key: "FIGMA_VISION_MODEL",
        label: "Vision model",
        type: "text",
        variant: "openrouter",
        placeholder: "google/gemini-2.5-flash",
        hint: "OpenRouter model that reads the design frames as images. The same model reads the prototype screenshots (Read prototype) and the requirement attachments, unless the attachments card names its own.",
      },
      {
        // Shown instead of the field above while Setup → AI model is on the Claude API.
        key: "CLAUDE_VISION_MODEL",
        label: "Vision model",
        type: "select",
        variant: "anthropic",
        placeholder: "same as Setup → AI model",
        options: ANTHROPIC_MODEL_OPTIONS,
        hint: "Claude model that reads the design frames as images. The same model reads the prototype screenshots (Read prototype) and the requirement attachments. Every Claude model reads images and PDFs; Sonnet or Haiku are cheaper when there are many screens. Empty: the model picked on Setup → AI model.",
      },
      {
        key: "FIGMA_MAX_FRAMES",
        label: "Max frames",
        type: "number",
        placeholder: "40",
      },
    ],
  },
  {
    // No required fields: attaching works with the defaults below. See attachment-analyzer.js.
    id: "attachments",
    title: "Requirement attachments",
    group: "sources",
    icon: "\u{1F4CE}",
    hint: "Images and PDFs attached on the Create, Update and Cover a bug pages are read by a vision model before generation and added to the prompt as requirements (labelled [A1], [A2]\u2026 so a case can be traced to its file). The files are sent to the AI provider picked on Setup \u2192 AI model: with OpenRouter, to the model below; with the Claude API, to the Claude vision model on the Figma card \u2014 attach only files without real patient or customer data.",
    fields: [
      {
        key: "ATTACHMENTS_VISION_MODEL",
        label: "Vision model",
        type: "text",
        // With the Claude API the files are read by the Claude vision model on the Figma card.
        variant: "openrouter",
        placeholder: "google/gemini-2.5-flash",
        hint: "Must accept images and PDF files. Empty: the Figma vision model, then google/gemini-2.5-flash.",
      },
      {
        key: "ATTACHMENTS_PDF_ENGINE",
        label: "PDF reading",
        type: "select",
        // An OpenRouter plugin; the Claude API reads PDFs itself.
        variant: "openrouter",
        options: [
          { value: "auto", label: "auto \u2014 the model reads the PDF itself when it can" },
          { value: "native", label: "native \u2014 always the model itself (input tokens)" },
          { value: "cloudflare-ai", label: "cloudflare-ai \u2014 text only, free" },
          { value: "mistral-ocr", label: "mistral-ocr \u2014 scanned PDFs (paid per page)" },
        ],
        placeholder: "auto",
        hint: "How OpenRouter turns a PDF into something the model reads. Use mistral-ocr for scans and photos of documents.",
      },
      {
        key: "ATTACHMENTS_MAX_FILES",
        label: "Max files per run",
        type: "number",
        placeholder: "10",
      },
      {
        key: "ATTACHMENTS_MAX_FILE_MB",
        label: "Max file size, MB",
        type: "number",
        placeholder: "20",
      },
      {
        key: "ATTACHMENTS_MAX_TOKENS",
        label: "Max tokens per file reading",
        type: "number",
        placeholder: "6000",
        hint: "Output cap for what the model extracts from one PDF or a batch of up to 4 images. Raise it for long specifications.",
      },
    ],
  },
];

const GROUPS = [
  { id: "core", title: "Required", hint: "The agent cannot run without these." },
  {
    id: "generation",
    title: "Generation",
    hint: "What generated test cases look like. Shared by every test management system.",
  },
  {
    id: "analysis",
    title: "Analyze requirements",
    hint: "Settings of the Analyze requirements page (grooming preparation).",
  },
  {
    id: "testmgmt",
    title: "Test management",
    hint: "Where test cases are stored. Configure as many providers as you like — the one marked In use is the target of a run.",
  },
  { id: "sources", title: "Extra context sources", hint: "Optional inputs for richer generation." },
];

/** Stored key holding the id of the provider a run should import into. */
const ACTIVE_PROVIDER_KEY = "TMS_PROVIDER";
/**
 * Nothing is In use until someone picks a provider on the Setup page. The import steps stay
 * disabled until then, rather than quietly aiming at Azure DevOps.
 */
const DEFAULT_PROVIDER = "";

/**
 * Settings that belong to the page as a whole rather than to one card.
 *
 * TMS_PROVIDER is rendered as the "In use" toggle in each provider card's
 * header, not as a field, so it deliberately sits outside SECTIONS — but it is
 * still a schema key, which is what makes readConfig()/writeConfig() accept and
 * persist it.
 */
const META_FIELDS = [
  {
    key: ACTIVE_PROVIDER_KEY,
    label: "Provider in use",
    type: "provider",
  },
  {
    // Formerly a field on the Confluence card. Not rendered any more (the Create / Update pages
    // take page links, which carry their host), but still accepted so an existing value is
    // kept: it resolves relative links in a Jira description. Defaults to JIRA_BASE_URL.
    key: "CONFLUENCE_BASE_URL",
    label: "Confluence base URL",
    type: "hidden",
  },
];

/** Flat key -> field lookup, built once. Covers the meta keys too. */
const FIELDS_BY_KEY = new Map();
for (const section of SECTIONS) {
  for (const field of section.fields) {
    if (field.type === "mirror") continue;
    FIELDS_BY_KEY.set(field.key, { ...field, sectionId: section.id });
  }
}
for (const field of META_FIELDS) FIELDS_BY_KEY.set(field.key, { ...field, sectionId: null });

/** Providers the toggle can choose between, in page order. */
const PROVIDER_SECTIONS = SECTIONS.filter((s) => s.provider);

/**
 * Which provider a run should import into.
 *
 * Tolerates the spellings a hand-written `.env` is likely to carry, and never
 * returns a provider whose card is still a placeholder — that would silently
 * disable the import with no way to see why.
 *
 * A provider that is configurable but has no CSV importer yet (Zephyr
 * Essential) *is* returned: the import then says so by name, which is the
 * difference between a visible gap and a run that quietly drops its output.
 *
 * @param {Record<string, string>} [values]
 * @returns {string} a section id, e.g. "ado" | "testrail" | "zephyr" — or "" when none is In use
 */
function activeProvider(values = readConfig()) {
  // Not process.env: loadEnv() copied the stored value in at start-up, and that copy would keep a
  // provider In use after the Setup page cleared it. The shell and a legacy .env still count.
  const raw = String(
    values[ACTIVE_PROVIDER_KEY] || SHELL_ENV[ACTIVE_PROVIDER_KEY] || readDotenvValues().values[ACTIVE_PROVIDER_KEY] || ""
  )
    .trim()
    .toLowerCase();
  const aliases = {
    ado: "ado",
    "azure-devops": "ado",
    azuredevops: "ado",
    azure: "ado",
    testrail: "testrail",
    "test-rail": "testrail",
    zephyr: "zephyr",
    // The app has been renamed twice, and there is only one Zephyr card, so
    // every spelling lands on it — including the sibling edition's name. A
    // value nobody recognises falls back to Azure DevOps silently, which is a
    // worse answer than the card the writer plainly meant.
    "zephyr-essential": "zephyr",
    zephyressential: "zephyr",
    "zephyr-squad": "zephyr",
    zephyrsquad: "zephyr",
    "zephyr-scale": "zephyr",
    xray: "xray",
    "x-ray": "xray",
  };
  const id = aliases[raw];
  if (!id) return DEFAULT_PROVIDER;
  const section = PROVIDER_SECTIONS.find((s) => s.id === id);
  if (!section || section.planned) return DEFAULT_PROVIDER;
  return id;
}

/**
 * The active provider plus the label to print for it.
 *
 * The Create and Update pages name the import destination in several places
 * (the Steps dropdown, the context panel, the generated commands). Hard-coding
 * "Azure DevOps" there makes the page lie the moment the In use toggle moves,
 * so they read the title from here instead.
 *
 * @param {Record<string, string>} [values]
 * @returns {{ id: string, title: string }}
 */
function activeProviderInfo(values = readConfig()) {
  const id = activeProvider(values);
  if (!id) return { id: "", title: "" };
  const section = PROVIDER_SECTIONS.find((s) => s.id === id);
  return { id, title: (section && section.title) || id };
}

/** The one sentence every import path says when no provider is In use. */
const NO_PROVIDER_MESSAGE =
  "No test management system is In use — pick one with “Use this” on the Setup page (Test management).";

const SECRET_KEYS = [...FIELDS_BY_KEY.values()].filter((f) => f.secret).map((f) => f.key);

function isSecretKey(key) {
  const f = FIELDS_BY_KEY.get(key);
  return !!(f && f.secret);
}

/** Is this key one the Setup page manages? Used to report what an import skipped. */
function isKnownKey(key) {
  return FIELDS_BY_KEY.has(key);
}

/** @returns {Record<string, string>} stored values; unknown and empty keys are dropped. */
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(STORE_PATH, "utf8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`config.local.json is not valid JSON (${e.message}); ignoring it.`);
    return {};
  }
  const values = parsed && typeof parsed === "object" ? parsed.values || parsed : {};
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (!FIELDS_BY_KEY.has(key)) continue;
    const s = value == null ? "" : String(value).trim();
    if (s) out[key] = s;
  }
  return out;
}

/**
 * Persists values. Keys unknown to the schema are rejected, empty values are
 * removed, and a secret sent as KEEP_SECRET keeps the stored one, so the UI
 * never has to round-trip a real token.
 *
 * @param {Record<string, unknown>} values
 * @returns {{ values: Record<string, string>, path: string }}
 */
function writeConfig(values) {
  const current = readConfig();
  const next = {};

  for (const key of FIELDS_BY_KEY.keys()) {
    const incoming = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    if (incoming === undefined) {
      if (current[key]) next[key] = current[key];
      continue;
    }
    const s = incoming == null ? "" : String(incoming).trim();
    if (s === KEEP_SECRET) {
      if (current[key]) next[key] = current[key];
      continue;
    }
    // Defensive: a secret echoed back as the display mask means "unchanged",
    // never a new token. Tested as "no alphanumerics at all" rather than by
    // matching bullet characters, so a mis-encoded mask (bullets arriving as
    // U+FFFD, say) can never overwrite a real credential. Removing a secret
    // goes through an empty string.
    if (s && isSecretKey(key) && !/[A-Za-z0-9]/.test(s)) {
      if (current[key]) next[key] = current[key];
      continue;
    }
    if (s) next[key] = s;
  }

  const payload = {
    // Written by the Setup page in the web UI — edit it there, not by hand.
    $schema: "ai-test-coverage-config/1",
    updatedAt: new Date().toISOString(),
    values: next,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  // Best effort on Windows, where mode bits are largely cosmetic.
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return { values: next, path: STORE_PATH };
}

function deleteConfig() {
  try {
    fs.unlinkSync(STORE_PATH);
    return true;
  } catch {
    return false;
  }
}

/** Replaces every secret with a fixed-width bullet run — safe to send to the browser. */
function maskValues(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = isSecretKey(key) && value ? "•".repeat(8) : value;
  }
  return out;
}

/**
 * What the UI may know about each secret: that one is stored, and how long it
 * is, so the field can be rendered as visibly filled. The value itself never
 * leaves the machine.
 *
 * @returns {Record<string, { set: boolean, length: number }>}
 */
function secretsPresent(values) {
  const out = {};
  for (const key of SECRET_KEYS) {
    const value = values[key] || "";
    out[key] = { set: !!value, length: value.length };
  }
  return out;
}

/**
 * Per-section completeness. States:
 *
 *   configured — every required field is filled
 *   partial    — some required fields are still missing
 *   empty      — nothing filled in yet
 *   off        — the section's `enabledBy` switch is not "true"
 *   defaults   — no required fields and nothing overridden
 *   custom     — no required fields, some defaults overridden
 *   planned    — integration not built yet
 *
 * @returns {Record<string, { state: string, missing: string[], filled: number, total: number }>}
 */
/**
 * The fields of a section that count right now: a field with a `variant` belongs to one option of
 * the AI provider switch (Setup → AI model) — on that card, the Figma card or the attachments card
 * — and is ignored while the other provider is picked. Display-only fields never count.
 */
function activeFieldsOf(section, values) {
  const picked = llmProviderOf(values);
  return section.fields.filter((f) => f.type !== "mirror" && (!f.variant || f.variant === picked));
}

function sectionStatus(values = readConfig()) {
  const out = {};
  for (const section of SECTIONS) {
    const fields = activeFieldsOf(section, values);
    // The switch always has a value (its default), so it says nothing about what was filled in.
    const filled = fields.filter((f) => f.type !== "toggle" && values[f.key]).length;
    const required = fields.filter((f) => f.required);
    const missing = required.filter((f) => !values[f.key]).map((f) => f.key);
    const row = { state: "empty", missing, filled, total: section.fields.length };

    if (section.planned) {
      row.state = "planned";
      row.missing = [];
    } else if (section.enabledBy && (values[section.enabledBy] || "") !== "true") {
      // A section behind a switch is "off", not "misconfigured".
      row.state = "off";
    } else if (!required.length) {
      // Nothing is mandatory here — these are defaults, not a setup step.
      row.state = filled ? "custom" : "defaults";
    } else if (!missing.length) {
      row.state = "configured";
    } else if (filled) {
      row.state = "partial";
    }

    out[section.id] = row;
  }
  return out;
}

/**
 * Remote-list metadata for one picker field, shaped for the browser.
 *
 * `sends` is derived from the list registry rather than repeated in the field,
 * so the set of credentials a picker posts is declared exactly once — next to
 * the code that reads them.
 */
function publicRemote(field) {
  const remote = field.remote;
  if (!remote || !remote.list) return null;
  const list = REMOTE_LISTS[remote.list];
  return {
    list: remote.list,
    sends: list ? [...list.reads] : [],
    needs: remote.needs || [],
    dependsOn: remote.dependsOn || [],
    preselect: remote.preselect || "",
    missing: remote.missing || "",
    reload: remote.reload || "Reload the list",
    empty: remote.empty || "Select one",
    unknown: remote.unknown || "{value}",
  };
}

/** Schema shaped for the browser. */
function publicSchema() {
  return {
    groups: GROUPS,
    // The "In use" toggle: which card owns it, and what the toggle writes.
    activeProvider: {
      key: ACTIVE_PROVIDER_KEY,
      group: "testmgmt",
      default: DEFAULT_PROVIDER,
      providers: PROVIDER_SECTIONS.map((s) => ({
        id: s.id,
        title: s.title,
        planned: !!s.planned,
      })),
    },
    sections: SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      group: s.group,
      icon: s.icon,
      iconSrc: s.iconSrc || null,
      hint: s.hint || "",
      planned: !!s.planned,
      provider: !!s.provider,
      enabledBy: s.enabledBy || null,
      test: s.test || null,
      docs: s.docs || null,
      panel: s.panel || null,
      fields: s.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: !!f.required,
        secret: !!f.secret,
        placeholder: f.placeholder || "",
        hint: f.hint || "",
        options: f.options || null,
        // The AI model card: which option of its switch a field belongs to, and the switch default.
        variant: f.variant || null,
        default: f.default || "",
        mirror: f.mirror || null,
        remote: publicRemote(f),
      })),
    })),
  };
}

/** Non-empty stored values as env vars. Empty ones are omitted so `.env` can still fill the gap. */
function configEnv() {
  const values = readConfig();
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Applies the store to this process, then `.env` for anything still unset.
 * Call once at the top of an entry script, INSTEAD of require("dotenv").config().
 */
function loadEnv() {
  const values = readConfig();
  for (const [key, value] of Object.entries(values)) {
    // A value already in the environment came from the shell, or from a parent
    // process choosing it for this run — either outranks the stored config.
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = value;
  }
  try {
    // quiet: the store, not .env, is the documented place to look now.
    require("dotenv").config({ quiet: true });
  } catch {
    /* dotenv missing or .env unparseable — stored config still applies */
  }
  applyLlmProviderEnv(process.env);
  return values;
}

/**
 * With the Claude API picked on Setup → AI model, the Claude-side token caps become the caps a run
 * reads (TEST_CASES_MAX_TOKENS, CHECKLIST_MAX_TOKENS, ADO_SYNC_BDD_MAX_TOKENS), falling back to
 * the Claude defaults while their fields are empty. A cap exported in the shell still wins, as
 * every shell value does. OpenRouter leaves the environment untouched.
 *
 * @param {Record<string, string>} env - mutated in place
 */
function applyLlmProviderEnv(env) {
  if (llmProviderOf(env) !== "anthropic") return env;
  for (const [claudeKey, target] of Object.entries(CLAUDE_TOKEN_CAP_TARGETS)) {
    if (Object.prototype.hasOwnProperty.call(SHELL_ENV, target)) continue;
    env[target] = String(env[claudeKey] || CLAUDE_TOKEN_CAP_DEFAULTS[claudeKey]);
  }
  return env;
}

/**
 * Environment for a spawned tool: pristine shell env, then the CURRENT stored
 * config (re-read, so an edit on the Setup page applies without a server
 * restart), then the target project's `.env` for whatever is still unset, then
 * the caller's per-run overrides.
 *
 * @param {string} [projectDir] project whose `.env` acts as fallback
 * @param {Record<string, string>} [overrides] per-run values, highest priority
 */
function childEnv(projectDir, overrides = {}) {
  const env = { ...SHELL_ENV, ...configEnv() };
  const envFile = path.join(projectDir || __dirname, ".env");
  if (fs.existsSync(envFile)) {
    try {
      // dotenv leaves existing keys alone, so this only fills real gaps.
      require("dotenv").config({ path: envFile, processEnv: env, quiet: true });
    } catch {
      /* ignore parse errors; the child may still load its own .env */
    }
  }
  applyLlmProviderEnv(env);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

/**
 * Reads `.env` and returns the values that belong to the schema, so the Setup
 * page can adopt an existing hand-written file in one click.
 * @returns {{ exists: boolean, path: string, values: Record<string, string>, skipped: string[], error?: string }}
 */
function readDotenvValues() {
  if (!fs.existsSync(DOTENV_PATH)) {
    return { exists: false, path: DOTENV_PATH, values: {}, skipped: [] };
  }
  let parsed = {};
  try {
    parsed = require("dotenv").parse(fs.readFileSync(DOTENV_PATH));
  } catch (e) {
    return { exists: true, path: DOTENV_PATH, values: {}, skipped: [], error: e.message };
  }
  const values = {};
  const skipped = [];
  for (const [key, raw] of Object.entries(parsed)) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) continue;
    if (FIELDS_BY_KEY.has(key)) values[key] = value;
    else skipped.push(key);
  }
  return { exists: true, path: DOTENV_PATH, values, skipped };
}

/** Values safe to share with a teammate: schema keys only, every secret stripped. */
function exportableValues(values = readConfig()) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Test Plans of the configured Azure DevOps project, for the Setup page's plan
 * pickers. `overrides` lets the page list plans for credentials the user has
 * typed but not saved yet — that is what makes the dropdown fill in as soon as
 * the PAT is pasted.
 *
 * Active plans come first, newest id first within each group. Never throws.
 *
 * @param {{ ADO_ORG?: string, ADO_PROJECT?: string, ADO_PAT?: string, ADO_SERVER_URL?: string }} [overrides]
 * @returns {Promise<{ ok: boolean, plans?: Array<{id:number,name:string,state:string}>, project?: string, error?: string }>}
 */
/**
 * Build an `AdoClient` from saved config, with `overrides` (credentials typed on the Setup page
 * but not saved yet) winning. Never throws — a missing field is a message, not an exception.
 *
 * @param {{ ADO_ORG?: string, ADO_PROJECT?: string, ADO_PAT?: string, ADO_SERVER_URL?: string }} [overrides]
 * @returns {{ ok: true, client: import("./ado-client").AdoClient, org: string, project: string } | { ok: false, error: string }}
 */
function adoClientFrom(overrides = {}) {
  const cfg = configEnv();
  const get = (key) => String(overrides[key] || "").trim() || cfg[key] || process.env[key] || "";
  const org = get("ADO_ORG");
  const project = get("ADO_PROJECT");
  const pat = get("ADO_PAT");
  if (!org || !project || !pat) {
    return { ok: false, error: "Azure DevOps organization, project and PAT are required" };
  }
  try {
    const { AdoClient } = require("./ado-client.js");
    const client = new AdoClient(org, project, pat, { baseUrl: get("ADO_SERVER_URL") || undefined });
    return { ok: true, client, org, project };
  } catch (e) {
    return { ok: false, error: readableAdoError((e && e.message) || String(e)) };
  }
}

/**
 * @param {object} [overrides] credentials typed on the Setup page but not saved yet
 * @param {{ activeOnly?: boolean }} [options] `activeOnly` asks Azure DevOps for active plans only
 *   (`filterActivePlans=true`) — fewer rows over the wire, and the archived sprint plans that
 *   dominate a long-lived project stay out of the picker.
 *
 *   Defaults to **false** so the Setup page keeps listing everything: its dropdown shows the
 *   *stored* `ADO_ACTIVE_TEST_PLAN_ID`, and filtering an already-saved inactive plan out of that
 *   list would make a valid saved config look empty.
 */
async function listAdoTestPlans(overrides = {}, options = {}) {
  const built = adoClientFrom(overrides);
  if (!built.ok) {
    return { ok: false, error: "Organization, project and PAT are required to list Test Plans" };
  }
  const { client, org, project } = built;
  const activeOnly = options.activeOnly === true;

  try {
    const raw = await client.listTestPlans({ filterActivePlans: activeOnly });
    // A rejected PAT does not come back as an HTTP error: Azure DevOps answers
    // 203 with a sign-in page, which the client happily returns as text. Anything
    // that is not a list means "not authenticated", not "no plans".
    if (!Array.isArray(raw)) {
      return { ok: false, error: "Azure DevOps returned a sign-in page — the PAT was rejected or has expired" };
    }
    const plans = raw
      .filter((p) => p && p.id != null)
      .map((p) => ({ id: Number(p.id), name: String(p.name || `Plan ${p.id}`), state: String(p.state || "") }));

    const rank = (p) => (/^active$/i.test(p.state) ? 0 : 1);
    plans.sort((a, b) => rank(a) - rank(b) || b.id - a.id);

    return { ok: true, org, project, plans, activeOnly };
  } catch (e) {
    return { ok: false, error: readableAdoError((e && e.message) || String(e)) };
  }
}

/**
 * Whole suite tree of one Test Plan, flattened for the context picker (`depth` drives the
 * indentation, `parentSuiteId` the collapse/expand state). One HTTP request thanks to
 * `asTreeView=true`. Never throws.
 *
 * @param {number} planId
 * @param {object} [overrides]
 */
async function listAdoSuiteTree(planId, overrides = {}) {
  const id = Number(planId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: "A numeric Test Plan id is required" };
  }
  const built = adoClientFrom(overrides);
  if (!built.ok) return built;
  try {
    const suites = await built.client.listSuiteTree(id);
    return { ok: true, planId: id, suites };
  } catch (e) {
    return { ok: false, error: readableAdoError((e && e.message) || String(e)) };
  }
}

/**
 * Test cases of one suite as `{ id, title, state, tags }` — enough to draw the checkbox list.
 * Step text is intentionally absent; it is fetched only for the ids the user actually ticks.
 * Never throws.
 *
 * @param {number} planId
 * @param {number} suiteId
 * @param {{ isRecursive?: boolean }} [options]
 * @param {object} [overrides]
 */
async function listAdoSuiteCases(planId, suiteId, options = {}, overrides = {}) {
  const pid = Number(planId);
  const sid = Number(suiteId);
  if (!Number.isInteger(pid) || pid < 1) return { ok: false, error: "A numeric Test Plan id is required" };
  if (!Number.isInteger(sid) || sid < 1) return { ok: false, error: "A numeric Test Suite id is required" };
  const built = adoClientFrom(overrides);
  if (!built.ok) return built;
  try {
    const cases = await built.client.listSuiteTestCaseSummaries(pid, sid, {
      isRecursive: options.isRecursive === true,
    });
    return { ok: true, planId: pid, suiteId: sid, cases };
  } catch (e) {
    return { ok: false, error: readableAdoError((e && e.message) || String(e)) };
  }
}

/**
 * Azure DevOps errors arrive as "… 404 Not Found. {json}". Surface the human
 * sentence inside that JSON instead of the whole envelope.
 */
function readableAdoError(raw) {
  const message = String(raw || "").split("\n")[0];
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart));
      if (parsed && parsed.message) return String(parsed.message).slice(0, 300);
    } catch {
      /* not JSON after all */
    }
  }
  return message.slice(0, 300);
}

// ── TestRail ───────────────────────────────────────────────────────────────

const TESTRAIL_CRED_KEYS = ["TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY"];

/**
 * Build a `TestRailClient` from saved config, with `overrides` (credentials
 * typed on the Setup page but not saved yet) winning. Never throws — a missing
 * field is a message, not an exception.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {{ ok: true, client: import("./testrail-client").TestRailClient, email: string } | { ok: false, error: string }}
 */
function testrailClientFrom(overrides = {}) {
  const cfg = configEnv();
  const get = (key) => String(overrides[key] || "").trim() || cfg[key] || process.env[key] || "";
  const base = get("TESTRAIL_BASE_URL");
  const email = get("TESTRAIL_EMAIL");
  const apiKey = get("TESTRAIL_API_KEY");
  if (!base || !email || !apiKey) {
    return { ok: false, error: "TestRail instance URL, email and API key are required" };
  }
  try {
    const { TestRailClient } = require("./testrail-client.js");
    return { ok: true, client: new TestRailClient(base, email, apiKey), email };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

/** TestRailError messages are written to be shown as-is; anything else gets trimmed. */
function testrailMessage(e) {
  return String((e && e.message) || e).slice(0, 300);
}

/**
 * Suites of the configured TestRail project, for the "Cover a bug"
 * destination picker.
 *
 * Deliberately not the Setup page's `testrail-suites` option list: that one is
 * a `{ value, label }` feed for a saved field, while this picker chooses a
 * one-off import target and also needs to know whether the project is
 * single-suite (then there is nothing to choose). Never throws.
 *
 * @param {object} [overrides]
 * @returns {Promise<{ ok: true, projectId: string, suites: Array<{ id: number, name: string }>, multiSuite: boolean } | { ok: false, error: string }>}
 */
async function listTestrailSuites(overrides = {}) {
  const built = testrailClientFrom(overrides);
  if (!built.ok) return { ok: false, error: built.error };
  const projectId = pickId(overrides, "TESTRAIL_PROJECT_ID");
  if (!projectId) {
    return { ok: false, error: "TestRail project is not set — pick one on the Setup page" };
  }
  try {
    const [project, suites] = await Promise.all([
      built.client.getProject(projectId).catch(() => null),
      built.client.listSuites(projectId),
    ]);
    return {
      ok: true,
      projectId: String(projectId),
      multiSuite: !!(project && Number(project.suite_mode) === 3),
      suites: suites
        .filter((s) => s && s.id != null)
        .map((s) => ({ id: Number(s.id), name: String(s.name || `Suite ${s.id}`) })),
    };
  } catch (e) {
    return { ok: false, error: testrailMessage(e) };
  }
}

/**
 * Sections of one suite, flattened for a picker.
 *
 * A TestRail section is what an Azure DevOps test suite is for the import — the
 * container a case is created in — so the rows come back under the same keys
 * (`suiteId`, `suiteName`, `path`, `depth`) as listAdoSuiteTree(), and the page
 * renders both with one function. Never throws.
 *
 * @param {number|string} suiteId omit on a single-suite project
 * @param {object} [overrides]
 */
async function listTestrailSections(suiteId, overrides = {}) {
  const built = testrailClientFrom(overrides);
  if (!built.ok) return { ok: false, error: built.error };
  const projectId = pickId(overrides, "TESTRAIL_PROJECT_ID");
  if (!projectId) {
    return { ok: false, error: "TestRail project is not set — pick one on the Setup page" };
  }
  const sid = String(suiteId || "").trim();
  try {
    const raw = await built.client.listSections(projectId, sid || undefined);
    // Same flattening the importer uses to match a section to a Jira key, so the
    // paths shown here are the paths that end up in the run log.
    const { flattenSections } = require("./testrail-sync-csv.js");
    const byId = new Map(raw.filter((s) => s && s.id != null).map((s) => [String(s.id), s]));
    const sections = flattenSections(raw).map((row) => {
      const src = byId.get(String(row.suiteId));
      const parent = src && src.parent_id != null ? Number(src.parent_id) : null;
      return {
        suiteId: row.suiteId,
        suiteName: row.suiteName,
        path: row.path,
        parentSuiteId: parent,
        depth: Math.max(0, row.path.split(" / ").length - 1),
      };
    });
    return { ok: true, projectId: String(projectId), suiteId: sid, sections };
  } catch (e) {
    return { ok: false, error: testrailMessage(e) };
  }
}

/** Runs one read against TestRail and folds every failure into `{ ok: false, error }`. */
async function withTestRail(values, fn) {
  const built = testrailClientFrom(values);
  if (!built.ok) return { ok: false, error: built.error };
  try {
    const result = await fn(built.client);
    return { ok: true, options: result.options || [], detail: result.detail || "" };
  } catch (e) {
    return { ok: false, error: testrailMessage(e) };
  }
}

// ── Zephyr Essential ───────────────────────────────────────────────────────

/**
 * Everything the Zephyr client needs before any project is chosen. The token
 * is the only credential: Essential 2.0 bears it rather than signing with it,
 * and it carries the identity of the Jira account that created it.
 */
const ZEPHYR_CRED_KEYS = ["ZEPHYR_API_TOKEN"];

/**
 * Build a `ZephyrEssentialClient` from saved config, with `overrides` (a token
 * typed on the Setup page but not saved yet) taking precedence.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {{ ok: true, client: import("./zephyr-client").ZephyrEssentialClient } | { ok: false, error: string }}
 */
function zephyrClientFrom(overrides = {}) {
  const cfg = { ...configEnv(), ...overrides };
  const get = (key) => String(cfg[key] || process.env[key] || "").trim();
  const token = get("ZEPHYR_API_TOKEN");
  if (!token) return { ok: false, error: "Zephyr Essential API token is required" };
  try {
    const { ZephyrEssentialClient } = require("./zephyr-client.js");
    // No base URL setting: Cloud is one fixed endpoint, wired into the client.
    return { ok: true, client: new ZephyrEssentialClient(token) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** ZephyrError messages are written to be shown as-is; anything else gets trimmed. */
function zephyrMessage(e) {
  if (e && e.name === "ZephyrError") return e.message;
  return String((e && e.message) || e).slice(0, 300);
}

/** Runs one read against Zephyr and folds every failure into `{ ok: false, error }`. */
async function withZephyr(values, fn) {
  const built = zephyrClientFrom(values);
  if (!built.ok) return { ok: false, error: built.error };
  try {
    const result = await fn(built.client);
    return { ok: true, options: result.options || [], detail: result.detail || "" };
  } catch (e) {
    return { ok: false, error: zephyrMessage(e) };
  }
}

/**
 * Test-case folders of the configured project, for the "Manual Import into …" step on the
 * Create and Update pages. Rows carry the same keys (`suiteId`, `suiteName`, `path`, `depth`)
 * as listAdoSuiteTree() and listTestrailSections(), so one picker renders all three — the id
 * is a string here where the other two are numeric, which is why nothing coerces it.
 *
 * The project is a Setup setting rather than an argument: Zephyr scopes folders by project,
 * and a run imports into the project the card names. Never throws.
 *
 * @param {object} [overrides]
 */
async function listZephyrFolders(overrides = {}) {
  const built = zephyrClientFrom(overrides);
  if (!built.ok) return { ok: false, error: built.error };
  const projectKey = pickId(overrides, "ZEPHYR_PROJECT_KEY");
  if (!projectKey) {
    return { ok: false, error: "Zephyr project is not set — pick one on the Setup page" };
  }
  try {
    const { buildFolderPaths } = require("./zephyr-client.js");
    const folders = buildFolderPaths(await built.client.listFolders(projectKey, "TEST_CASE")).map(
      (f) => ({ suiteId: f.id, suiteName: f.name, path: f.path, depth: f.depth })
    );
    return { ok: true, projectKey, folders };
  } catch (e) {
    return { ok: false, error: zephyrMessage(e) };
  }
}

/** Xray's own key pair — not the Jira credentials, and both halves are needed to buy a token. */
const XRAY_CRED_KEYS = ["XRAY_CLIENT_ID", "XRAY_CLIENT_SECRET", "XRAY_BASE_URL"];

/**
 * Build an `XrayClient` from saved config, with `overrides` (keys typed on the Setup page but not
 * saved yet) taking precedence.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {{ ok: true, client: import("./xray-client").XrayClient } | { ok: false, error: string }}
 */
function xrayClientFrom(overrides = {}) {
  const cfg = { ...configEnv(), ...overrides };
  const get = (key) => String(cfg[key] || process.env[key] || "").trim();
  const clientId = get("XRAY_CLIENT_ID");
  const clientSecret = get("XRAY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return { ok: false, error: "Xray Client ID and Client Secret are required" };
  }
  try {
    const { XrayClient } = require("./xray-client.js");
    return { ok: true, client: new XrayClient({ baseUrl: get("XRAY_BASE_URL"), clientId, clientSecret }) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** XrayError messages are written to be shown as-is; anything else gets trimmed. */
function xrayMessage(e) {
  if (e && e.name === "XrayError") return e.message;
  return String((e && e.message) || e).slice(0, 300);
}

/** Project ids already read from Xray, by key — they never change, so one lookup per server run. */
const xrayProjectIds = new Map();

/**
 * The numeric project id behind a key, asked of Xray itself: `getProjectSettings` takes a key, and
 * `getTests` carries the id on any test in the project as a second way in. "" when neither answers
 * (no key pair, keys rejected, an empty project on an API without the first query) — the caller
 * falls back to Jira then.
 */
async function xrayProjectIdFromXray(projectKey, overrides = {}) {
  if (xrayProjectIds.has(projectKey)) return xrayProjectIds.get(projectKey);
  const built = xrayClientFrom(overrides);
  if (!built.ok) return "";
  const attempts = [
    async () => {
      const data = await built.client.graphql(
        "query($key: String) { getProjectSettings(projectIdOrKey: $key) { projectId } }",
        { key: projectKey }
      );
      return data && data.getProjectSettings && data.getProjectSettings.projectId;
    },
    async () => {
      const data = await built.client.graphql(
        "query($jql: String) { getTests(jql: $jql, limit: 1) { results { projectId } } }",
        { jql: `project = "${String(projectKey).replace(/"/g, "")}"` }
      );
      const first = data && data.getTests && (data.getTests.results || [])[0];
      return first && first.projectId;
    },
  ];
  for (const attempt of attempts) {
    try {
      const id = String((await attempt()) || "");
      if (id) {
        xrayProjectIds.set(projectKey, id);
        return id;
      }
    } catch {
      /* try the next way in, then Jira */
    }
  }
  return "";
}

/**
 * Which Jira credentials the Xray card's id lookup runs with.
 *
 * Xray's folder queries take the project's *numeric* id. That is read from Xray first (see
 * xrayProjectIdFromXray); Jira is the fallback, and the one place it is required is the issue link
 * from a created test to its ticket — the question is only whose Jira.
 *
 * The main Jira card, which is right when Xray sits in the same Jira the tickets come from. A
 * separate Xray site is no longer on the Setup card; XRAY_JIRA_BASE_URL / _EMAIL / _API_TOKEN still
 * win from `.env`, read as a **set**: a site from there with an email from the Jira card would
 * authenticate the wrong account against the wrong host and fail in a way nobody could read.
 *
 * @returns {{ base: string, email: string, token: string, source: "xray"|"jira", missing: string[] }}
 */
function xrayJiraCreds(cfg) {
  const get = (key) => String(cfg[key] || process.env[key] || "").trim();
  const own = get("XRAY_JIRA_BASE_URL");
  if (own) {
    const creds = { base: own.replace(/\/+$/, ""), email: get("XRAY_JIRA_EMAIL"), token: get("XRAY_JIRA_API_TOKEN") };
    const missing = [];
    if (!creds.email) missing.push("XRAY_JIRA_EMAIL");
    if (!creds.token) missing.push("XRAY_JIRA_API_TOKEN");
    return { ...creds, source: "xray", missing };
  }
  const base = (get("JIRA_BASE_URL") || get("BASE_URL")).replace(/\/+$/, "");
  const email = get("JIRA_EMAIL") || get("LOGIN_EMAIL");
  const token = get("JIRA_API_TOKEN");
  const missing = [];
  if (!base) missing.push("JIRA_BASE_URL");
  if (!email) missing.push("JIRA_EMAIL");
  if (!token) missing.push("JIRA_API_TOKEN");
  return { base, email, token, source: "jira", missing };
}

/**
 * The numeric Jira project id behind a project key, for Xray's folder queries.
 *
 * @returns {Promise<string>} "" when it cannot be resolved; callers degrade rather than fail
 */
async function jiraProjectIdFor(projectKey, overrides = {}) {
  return (await resolveXrayProjectId(projectKey, overrides)).id;
}

/**
 * The same lookup, but it says *why* it failed — the Setup page and the importer both have
 * somewhere useful to put that, and "could not resolve" on its own sends people hunting through
 * the wrong card.
 *

 * @returns {Promise<{ id: string, source: string, error: string }>}
 */
async function resolveXrayProjectId(projectKey, overrides = {}) {
  const cfg = { ...configEnv(), ...overrides };
  if (!projectKey) return { id: "", source: "", error: "No Xray project key set" };

  // Xray first: it needs nothing but the API key pair, which is what makes the Jira fields optional
  // when Xray sits in the same Jira as the tickets — or when no Jira account is at hand at all.
  const fromXray = await xrayProjectIdFromXray(projectKey, overrides);
  if (fromXray) return { id: fromXray, source: "xray-api", error: "" };

  const { base, email, token, source, missing } = xrayJiraCreds(cfg);
  const whose = source === "xray" ? "the Xray Jira site set in .env" : "the Jira card";
  if (missing.length) {
    return {
      id: "",
      source,
      error: `${whose} ${missing.length > 1 ? "are" : "is"} incomplete (${missing.join(", ")})`,
    };
  }

  const fetchFn = globalThis.fetch || require("node-fetch");
  try {
    const res = await fetchFn(`${base}/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      // The single most likely misconfiguration, and the one worth naming the host for: Xray on
      // one site, the Jira card pointed at another.
      return {
        id: "",
        source,
        error: `${base} has no project "${projectKey}" — ${source === "jira" ? "the Jira card points at a different site than Xray does; set XRAY_JIRA_BASE_URL, XRAY_JIRA_EMAIL and XRAY_JIRA_API_TOKEN in .env" : "check the key"}`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { id: "", source, error: `${base} rejected ${whose} (HTTP ${res.status})` };
    }
    if (!res.ok) return { id: "", source, error: `${base} answered HTTP ${res.status}` };
    const body = await res.json();
    const id = String((body && body.id) || "");
    return id ? { id, source, error: "" } : { id: "", source, error: `${base} returned no id for "${projectKey}"` };
  } catch (e) {
    return { id: "", source, error: `Cannot reach ${base}: ${(e && e.message) || e}` };
  }
}

/**
 * Test Repository folders of the configured project, for the "Manual Import into …" step on the
 * Create and Update pages. Rows carry the same keys (`suiteId`, `suiteName`, `path`, `depth`) as
 * listAdoSuiteTree() and listZephyrFolders(), so one picker renders all four — the id here is the
 * folder *path*, because that is how Xray addresses a folder.
 *
 * The repository root is always offered: a project with no folders still needs somewhere to file
 * tests, and "/" is where Xray puts them. Never throws.
 *
 * @param {object} [overrides]
 */
async function listXrayFolders(overrides = {}) {
  const built = xrayClientFrom(overrides);
  if (!built.ok) return { ok: false, incomplete: true, error: built.error };
  const projectKey = pickId(overrides, "XRAY_PROJECT_KEY") || pickId(overrides, "PROJECT_KEY");
  if (!projectKey) {
    return { ok: false, incomplete: true, error: "Fill in the Jira project key to load folders" };
  }
  const resolved = await resolveXrayProjectId(projectKey, overrides);
  if (!resolved.id) {
    // `incomplete`, not an error: a card halfway through being filled in has not gone wrong, and a
    // red "could not load" over a field the reader has not reached yet reads like a fault to fix
    // rather than a step still to take. `detail` keeps the long diagnosis for anywhere that wants
    // it — Test connection says the same thing at the point where it is genuinely a verdict.
    return {
      ok: false,
      incomplete: true,
      error: `No numeric project id for "${projectKey}" yet — check the Xray keys and the project key`,
      detail: resolved.error,
    };
  }
  const projectId = resolved.id;
  try {
    const folders = (await built.client.listFolders(projectId)).map((f) => ({
      suiteId: f.path,
      suiteName: f.name,
      path: f.path,
      depth: f.path.split("/").filter(Boolean).length,
    }));
    return {
      ok: true,
      projectKey,
      folders: [{ suiteId: "/", suiteName: "Test Repository (root)", path: "/", depth: 0 }, ...folders],
    };
  } catch (e) {
    return { ok: false, error: xrayMessage(e) };
  }
}

/** A dependency's value: what the page posted, else what is already saved. */
function pickId(values, key) {
  const typed = String((values && values[key]) || "").trim();
  if (typed) return typed;
  const cfg = configEnv();
  return String(cfg[key] || process.env[key] || "").trim();
}

// ── live option lists behind the Setup page's pickers ──────────────────────

/**
 * `reads` is the whitelist of keys one list may receive. The browser posts the
 * credentials the user has typed but not saved yet, so this is also what stops
 * anything outside a list's own inputs from reaching a client factory over the
 * network.
 *
 * Every `run` resolves to `{ ok, options: [{ value, label, title?, group? }], detail }`
 * — the picker is deliberately dumb about which provider it is showing.
 */
const REMOTE_LISTS = {
  "ado-test-plans": {
    reads: ["ADO_ORG", "ADO_PROJECT", "ADO_PAT", "ADO_SERVER_URL"],
    async run(values) {
      const result = await listAdoTestPlans(values);
      if (!result.ok) return { ok: false, error: result.error };
      const options = result.plans.map((p) => ({
        value: String(p.id),
        label: p.name,
        title: `id ${p.id}`,
        group: /^active$/i.test(p.state) ? "Active" : "Inactive",
      }));
      return { ok: true, options, detail: `${options.length} plans in ${result.project}` };
    },
  },

  "testrail-projects": {
    reads: TESTRAIL_CRED_KEYS,
    async run(values) {
      return withTestRail(values, async (client) => {
        const projects = (await client.listProjects()).filter((p) => p && p.id != null);
        const options = projects.map((p) => ({
          value: String(p.id),
          label: String(p.name || `Project ${p.id}`),
          title: `id ${p.id}`,
          // A completed project is an archive, not an import target.
          group: p.is_completed ? "Completed" : "Active",
        }));
        options.sort((a, b) => (a.group === b.group ? 0 : a.group === "Active" ? -1 : 1));
        return { options, detail: `${options.length} projects visible` };
      });
    },
  },

  "testrail-suites": {
    reads: [...TESTRAIL_CRED_KEYS, "TESTRAIL_PROJECT_ID"],
    async run(values) {
      const projectId = pickId(values, "TESTRAIL_PROJECT_ID");
      if (!projectId) return { ok: false, error: "Pick a project first" };
      return withTestRail(values, async (client) => {
        const [project, suites] = await Promise.all([
          client.getProject(projectId).catch(() => null),
          client.listSuites(projectId),
        ]);
        const options = suites
          .filter((s) => s && s.id != null)
          .map((s) => ({
            value: String(s.id),
            label: String(s.name || `Suite ${s.id}`),
            title: `id ${s.id}`,
          }));
        const multi = project && Number(project.suite_mode) === 3;
        const detail = multi
          ? `${options.length} suites · multi-suite project`
          : options.length === 1
            ? `single-suite project · ${options[0].label}`
            : `${options.length} suites`;
        return { options, detail };
      });
    },
  },

  "testrail-templates": {
    reads: [...TESTRAIL_CRED_KEYS, "TESTRAIL_PROJECT_ID"],
    async run(values) {
      const projectId = pickId(values, "TESTRAIL_PROJECT_ID");
      if (!projectId) return { ok: false, error: "Pick a project first" };
      return withTestRail(values, async (client) => {
        const options = (await client.listTemplates(projectId))
          .filter((t) => t && t.id != null)
          .map((t) => ({
            value: String(t.id),
            label: `${t.name || `Template ${t.id}`}${t.is_default ? " (default)" : ""}`,
            title: `id ${t.id}`,
          }));
        return { options, detail: `${options.length} templates` };
      });
    },
  },

  "testrail-case-types": {
    reads: TESTRAIL_CRED_KEYS,
    async run(values) {
      return withTestRail(values, async (client) => {
        const options = (await client.listCaseTypes())
          .filter((t) => t && t.id != null)
          .map((t) => ({
            value: String(t.id),
            label: `${t.name || `Type ${t.id}`}${t.is_default ? " (default)" : ""}`,
            title: `id ${t.id}`,
          }));
        return { options, detail: `${options.length} case types` };
      });
    },
  },

  "xray-folders": {
    // Everything listXrayFolders() touches: the Xray key pair for the tree, and every field that
    // can resolve the numeric project id — Xray itself, a .env Xray Jira site, or the main Jira card.
    reads: [
      ...XRAY_CRED_KEYS,
      "XRAY_PROJECT_KEY",
      "XRAY_JIRA_BASE_URL",
      "XRAY_JIRA_EMAIL",
      "XRAY_JIRA_API_TOKEN",
    ],
    async run(values) {
      const r = await listXrayFolders(values);
      if (!r.ok) return { ok: false, incomplete: !!r.incomplete, error: r.error };
      const options = (r.folders || []).map((f) => ({
        value: String(f.path),
        // Depth as indentation: the tree is what makes two folders of the same name tellable
        // apart, and a flat list of leaf names hides exactly that.
        label: f.depth ? `${"\u00a0\u00a0".repeat(f.depth)}${f.suiteName}` : f.suiteName,
        title: f.path,
      }));
      const real = Math.max(0, options.length - 1); // the root row is ours, not Xray's
      return { options, detail: real === 1 ? "1 folder" : `${real} folders` };
    },
  },

  "zephyr-projects": {
    reads: ZEPHYR_CRED_KEYS,
    async run(values) {
      return withZephyr(values, async (client) => {
        // /projects carries no display name, so the key is both the value and
        // the label; the Jira project id goes in the tooltip to tell two
        // similarly named keys apart.
        const options = (await client.listProjects())
          .filter((p) => p && p.key)
          .map((p) => ({
            value: String(p.key),
            label: String(p.key),
            title: p.jiraProjectId ? `Jira project ${p.jiraProjectId}` : `id ${p.id}`,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        return { options, detail: `${options.length} projects with Zephyr enabled` };
      });
    },
  },
};

/**
 * Runs one option list for the Setup page. Never throws.
 *
 * @param {string} listId key of REMOTE_LISTS
 * @param {Record<string, unknown>} [values] values typed on the page but not saved yet;
 *   anything outside the list's own `reads` whitelist is dropped
 * @returns {Promise<{ ok: boolean, options?: Array<{ value: string, label: string, title?: string, group?: string }>, detail?: string, error?: string }>}
 */
async function listRemoteOptions(listId, values = {}) {
  const list = REMOTE_LISTS[String(listId || "")];
  if (!list) return { ok: false, error: `Unknown option list "${listId}"` };

  const clean = {};
  for (const key of list.reads) {
    const raw = values ? values[key] : undefined;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    // Defensive, same rule as writeConfig(): a masked or placeholder secret
    // means "use the stored one", never "authenticate with these characters".
    if (isSecretKey(key) && (value === KEEP_SECRET || !/[A-Za-z0-9]/.test(value))) continue;
    clean[key] = value;
  }

  try {
    return await list.run(clean);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

/**
 * Live credential checks — one per implemented provider. Never throws: the
 * failure message is what the Setup page shows next to the button.
 *
 * @param {string} provider "jira" | "ado" | "testrail" | "zephyr" | "openrouter" | "figma"
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function testConnection(provider) {
  const fetchFn = globalThis.fetch || require("node-fetch");
  const cfg = { ...configEnv() };
  // Fall back to whatever the process already has, so a value that still only
  // lives in `.env` can be verified before it is migrated into the store.
  const get = (key) => cfg[key] || process.env[key] || "";

  const request = async (url, headers) => {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    return { res, body, text };
  };

  try {
    if (provider === "jira") {
      const base = get("JIRA_BASE_URL").replace(/\/+$/, "");
      const email = get("JIRA_EMAIL");
      const token = get("JIRA_API_TOKEN");
      if (!base || !email || !token) return { ok: false, detail: "Base URL, email and API token are required" };
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const { res, body } = await request(`${base}/rest/api/3/myself`, {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `Credentials rejected (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };
      const name = (body && (body.displayName || body.emailAddress)) || "unknown user";
      return { ok: true, detail: `Signed in as ${name}` };
    }

    if (provider === "ado") {
      const org = get("ADO_ORG");
      const project = get("ADO_PROJECT");
      const pat = get("ADO_PAT");
      if (!org || !project || !pat) return { ok: false, detail: "Organization, project and PAT are required" };
      const host = (get("ADO_SERVER_URL") || "https://dev.azure.com").replace(/\/+$/, "");
      const auth = Buffer.from(`:${pat}`).toString("base64");
      const url = `${host}/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(
        project
      )}?api-version=7.1-preview.4`;
      const { res, body } = await request(url, { Authorization: `Basic ${auth}`, Accept: "application/json" });
      // ADO answers an unauthenticated request with 203 + a sign-in page.
      if (res.status === 401 || res.status === 203) {
        return { ok: false, detail: "PAT rejected — check the token and its scopes" };
      }
      if (res.status === 404) return { ok: false, detail: `Project "${project}" not found in organization "${org}"` };
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };

      const planId = get("ADO_ACTIVE_TEST_PLAN_ID");
      let planNote = "";
      if (planId) {
        const planUrl = `${host}/${encodeURIComponent(org)}/${encodeURIComponent(
          project
        )}/_apis/testplan/plans/${encodeURIComponent(planId)}?api-version=7.1`;
        const plan = await request(planUrl, { Authorization: `Basic ${auth}`, Accept: "application/json" });
        planNote =
          plan.res.ok && plan.body && plan.body.name
            ? ` · plan ${planId}: ${plan.body.name}`
            : ` · plan ${planId} unreachable (HTTP ${plan.res.status})`;
      }
      const projectName = (body && body.name) || project;
      return { ok: true, detail: `Project ${projectName}${planNote}` };
    }

    if (provider === "testrail") {
      const built = testrailClientFrom();
      if (!built.ok) return { ok: false, detail: built.error };
      const { client } = built;

      // get_projects is the one read every authenticated user is allowed, so it
      // doubles as the credential check. A 403 here is almost always the API
      // switch in Administration → Site Settings → API (see testrail-client.js).
      const projects = await client.listProjects();
      const parts = [`Signed in as ${built.email}`, `${projects.length} projects`];

      // Then confirm the saved targets resolve, the way the ADO test confirms
      // its plan: a valid key pointing at a deleted section is still broken.
      const projectId = get("TESTRAIL_PROJECT_ID");
      if (projectId) {
        try {
          const project = await client.getProject(projectId);
          const multi = Number(project.suite_mode) === 3 ? ", multi-suite" : "";
          parts.push(`project ${project.name || projectId}${multi}`);
        } catch (e) {
          parts.push(`project ${projectId} unreachable (${testrailMessage(e)})`);
        }
      }
      const suiteId = get("TESTRAIL_SUITE_ID");
      if (suiteId) {
        try {
          const suite = await client.getSuite(suiteId);
          parts.push(`suite ${suite.name || suiteId}`);
        } catch (e) {
          parts.push(`suite ${suiteId} unreachable (${testrailMessage(e)})`);
        }
      }
      return { ok: true, detail: parts.join(" · ") };
    }

    if (provider === "zephyr") {
      const built = zephyrClientFrom();
      if (!built.ok) return { ok: false, detail: built.error };
      const { client } = built;

      // /healthcheck answers any valid token, so it separates "the token is
      // wrong" from "the token is fine but the project key is". Without it a
      // typo'd key would read as a credential failure.
      await client.healthcheck();
      const parts = ["Token accepted"];

      const projectKey = get("ZEPHYR_PROJECT_KEY");
      if (!projectKey) {
        const projects = await client.listProjects();
        parts.push(`${projects.length} projects available`);
        return { ok: true, detail: parts.join(" · ") };
      }

      // Then confirm the saved targets resolve, the way the ADO test confirms
      // its plan: a valid token pointing at a deleted folder is still broken.
      let folders = [];
      try {
        folders = await client.listFolders(projectKey, "TEST_CASE");
        parts.push(`project ${projectKey}: ${folders.length} folders`);
      } catch (e) {
        parts.push(`project ${projectKey} unreachable (${zephyrMessage(e)})`);
        return { ok: false, detail: parts.join(" · ") };
      }

      const folderId = get("ZEPHYR_FOLDER_ID");
      if (folderId) {
        const folder = folders.find((f) => f && String(f.id) === String(folderId));
        parts.push(
          folder ? `folder ${folder.name || folderId}` : `folder ${folderId} is not in this project`
        );
        if (!folder) return { ok: false, detail: parts.join(" · ") };
      }
      return { ok: true, detail: parts.join(" · ") };
    }

    // The AI model card has one button; it checks whichever provider the card's switch is on.
    if (provider === "ai") {
      provider = llmProviderOf({ [LLM_PROVIDER_KEY]: get(LLM_PROVIDER_KEY) }) === "anthropic" ? "anthropic" : "openrouter";
    }

    if (provider === "anthropic") {
      const key = get("ANTHROPIC_API_KEY");
      if (!key) return { ok: false, detail: "Claude API key is required" };
      const model = get("ANTHROPIC_MODEL") || DEFAULT_ANTHROPIC_MODEL;
      // Looking the picked model up proves both the key and that this key may use that model.
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new (Anthropic.default || Anthropic)({ apiKey: key, timeout: 15000, maxRetries: 0 });
      try {
        const info = await client.models.retrieve(model);
        return { ok: true, detail: `Key valid · model ${info.display_name || model} available` };
      } catch (e) {
        if (e && e.status === 401) return { ok: false, detail: "Key rejected (401) — check it is a Claude Console API key" };
        if (e && e.status === 403) return { ok: false, detail: "Key has no access (403) — ask your Claude Console admin" };
        if (e && e.status === 404) return { ok: false, detail: `Key valid, but model "${model}" is not available to it` };
        return { ok: false, detail: `${e && e.status ? `HTTP ${e.status}: ` : ""}${(e && e.message) || e}`.slice(0, 300) };
      }
    }

    if (provider === "openrouter") {
      const key = get("OPENROUTER_API_KEY");
      if (!key) return { ok: false, detail: "API key is required" };
      const { res, body } = await request("https://openrouter.ai/api/v1/key", {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      });
      if (res.status === 401) return { ok: false, detail: "Key rejected (401)" };
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };
      const data = (body && body.data) || {};
      const limit = data.limit == null ? "no spend limit" : `limit ${data.limit}`;
      const models = get("OPENROUTER_MODELS");
      const first = models ? models.split(",")[0].trim() : "";
      return { ok: true, detail: `Key valid (${limit})${first ? ` · first model: ${first}` : ""}` };
    }

    if (provider === "xray") {
      const built = xrayClientFrom(cfg);
      if (!built.ok) return { ok: false, detail: built.error };
      const projectKey = get("XRAY_PROJECT_KEY") || get("PROJECT_KEY");
      try {
        // Buying the token is the credential test: a wrong key pair answers 401 here, before any
        // query, which is a far clearer thing to report than a GraphQL error about a query the
        // user never typed.
        await built.client.authenticate(true);
      } catch (e) {
        return { ok: false, detail: xrayMessage(e) };
      }
      if (!projectKey) return { ok: true, detail: "Keys accepted · no project key set yet" };

      // With a project, say something about it: the folder read is the cheapest call that proves
      // Xray is actually switched on for that project rather than just reachable.
      const resolved = await resolveXrayProjectId(projectKey, cfg);
      if (!resolved.id) {
        // Not a failure: the import still runs, it just files everything at the configured root
        // because folder matching needs the id. Say both halves.
        return {
          ok: true,
          detail: `Keys accepted · no folder tree: ${resolved.error} · tests will go to ${get("XRAY_FOLDER_PATH") || "/"}`,
        };
      }
      try {
        const folders = await built.client.listFolders(resolved.id);
        const via = `id via ${
          resolved.source === "xray-api" ? "Xray" : resolved.source === "xray" ? "the .env Xray Jira site" : "the Jira card"
        }`;
        return { ok: true, detail: `Keys accepted · ${projectKey} · ${folders.length} repository folder(s) · ${via}` };
      } catch (e) {
        return { ok: false, detail: `Keys accepted, but ${projectKey} did not answer: ${xrayMessage(e)}` };
      }
    }

    if (provider === "figma") {
      const token = get("FIGMA_TOKEN");
      if (!token) return { ok: false, detail: "Token is required" };
      const { res, body } = await request("https://api.figma.com/v1/me", {
        "X-Figma-Token": token,
        Accept: "application/json",
      });
      if (res.status === 403) return { ok: false, detail: "Token rejected (403)" };
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };
      const who = (body && (body.email || body.handle)) || "unknown user";
      return { ok: true, detail: `Signed in as ${who}` };
    }

    return { ok: false, detail: `No connection test for "${provider}"` };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "Timed out after 15s" : (e && e.message) || String(e);
    return { ok: false, detail: msg };
  }
}

module.exports = {
  SECTIONS,
  GROUPS,
  SECRET_KEYS,
  KEEP_SECRET,
  ACTIVE_PROVIDER_KEY,
  DEFAULT_PROVIDER,
  NO_PROVIDER_MESSAGE,
  activeProvider,
  activeProviderInfo,
  STORE_PATH,
  DOTENV_PATH,
  SHELL_ENV,
  isSecretKey,
  isKnownKey,
  readConfig,
  writeConfig,
  deleteConfig,
  maskValues,
  secretsPresent,
  sectionStatus,
  publicSchema,
  configEnv,
  loadEnv,
  childEnv,
  readDotenvValues,
  exportableValues,
  listAdoTestPlans,
  listAdoSuiteTree,
  listAdoSuiteCases,
  adoClientFrom,
  readableAdoError,
  testrailClientFrom,
  zephyrClientFrom,
  listTestrailSuites,
  listTestrailSections,
  listZephyrFolders,
  xrayClientFrom,
  listXrayFolders,
  jiraProjectIdFor,
  resolveXrayProjectId,
  xrayJiraCreds,
  listRemoteOptions,
  testConnection,
};
