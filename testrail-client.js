/**
 * TestRail API v2 client — the read paths the Setup page needs (projects,
 * suites, sections, templates, case types), the lookups the import resolves
 * against (priorities, case fields), and the two writes the import performs
 * (add_case, add_section).
 *
 * Three things about this API shape the whole file:
 *
 *  1. The "path" lives inside the query string:
 *     `https://co.testrail.io/index.php?/api/v2/get_sections/12&suite_id=3`
 *     so URLs are hand-built — `new URL()` / `URLSearchParams` would escape
 *     the `?/api/v2/...` part and TestRail would answer with its web UI.
 *  2. Collection endpoints changed shape in TestRail 6.7: what used to be a
 *     bare array became `{ offset, limit, size, _links, <collection>: [] }`.
 *     getCollection() reads both and pages through the second.
 *  3. TestRail Cloud rate-limits and answers 429 with `Retry-After`. The
 *     import creates one case per request, so backoff is not optional.
 *
 * The API itself must be switched on per instance:
 * Administration → Site Settings → API → "Enable API". Until then every call
 * comes back 403.
 */
const fetch = globalThis.fetch || require("node-fetch");

const DEFAULT_TIMEOUT_MS = 20000;
/** TestRail's own maximum page size for paginated endpoints. */
const PAGE_LIMIT = 250;
/** 10k rows. A picker never needs more, and this stops a runaway paging loop. */
const MAX_PAGES = 40;
const MAX_RETRIES = 2;

class TestRailError extends Error {
  /**
   * @param {string} message already human-readable — safe to show in the UI
   * @param {number} [status] HTTP status, when the failure came from a response
   */
  constructor(message, status) {
    super(message);
    this.name = "TestRailError";
    this.status = status;
  }
}

/**
 * `https://co.testrail.io/index.php?/api/v2/` → `https://co.testrail.io`
 * Accepts a bare host, tolerates a pasted API URL, and defaults to https.
 */
function normalizeBaseUrl(raw) {
  let base = String(raw || "").trim();
  if (!base) return "";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  // Everything from /index.php on is ours to build.
  base = base.replace(/\/index\.php.*$/i, "");
  return base.replace(/\/+$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Honours `Retry-After` when TestRail sends one, otherwise backs off 0.5s, 1s. */
function retryAfterMs(res, attempt) {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10000);
  return 500 * 2 ** attempt;
}

/**
 * One sentence a QA engineer can act on. TestRail sends `{ "error": "..." }`
 * for anything it recognises; an HTML body means the URL is not an API URL.
 */
function errorMessage(res, body, text) {
  const apiError = body && typeof body.error === "string" ? body.error.trim() : "";
  if (res.status === 401) {
    // TestRail's own wording ("invalid or missing user/password or session
    // cookie") reads like a session problem, which sends people looking in the
    // wrong place. A 401 here is nearly always one of two things: the key was
    // generated but the My Settings page was left without Save Settings, so
    // TestRail never stored it; or the email is not the login email of the
    // account that owns the key.
    return "Email or API key rejected (401) — the key only exists after Save Settings on My Settings, and the email must be the login email of the account that owns it";
  }
  if (res.status === 403) {
    if (apiError && /(not enabled|disabled)/i.test(apiError)) {
      return `${apiError} — switch it on in Administration → Site Settings → API`;
    }
    return (
      apiError ||
      "Access denied (403) — the API may be disabled in Administration → Site Settings → API"
    );
  }
  if (res.status === 429) return apiError || "Rate limit reached (429) — try again in a moment";
  if (apiError) return `${apiError} (HTTP ${res.status})`;
  const snippet = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`;
}

const seg = (value) => encodeURIComponent(String(value == null ? "" : value).trim());

class TestRailClient {
  /**
   * @param {string} baseUrl instance URL, e.g. `https://yourco.testrail.io`
   * @param {string} email login email of the API user
   * @param {string} apiKey User → My Settings → API Keys (the account password also works
   *   unless the instance requires keys)
   * @param {{ timeoutMs?: number }} [options]
   */
  constructor(baseUrl, email, apiKey, options = {}) {
    const base = normalizeBaseUrl(baseUrl);
    const mail = String(email || "").trim();
    const key = String(apiKey || "").trim();
    if (!base || !mail || !key) {
      throw new TestRailError("TestRailClient: instance URL, email and API key are required");
    }
    this.baseUrl = base;
    this.email = mail;
    this.auth = Buffer.from(`${mail}:${key}`).toString("base64");
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * @param {string} method API method with its path segments, e.g. `get_sections/12`
   * @param {Record<string, string|number|undefined>} [params] appended as `&k=v`
   */
  url(method, params = {}) {
    const extra = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("");
    return `${this.baseUrl}/index.php?/api/v2/${method}${extra}`;
  }

  /**
   * One request, retried on 429. A body makes it a POST.
   *
   * @param {string} method
   * @param {Record<string, string|number|undefined>} [params]
   * @param {{ body?: unknown }} [options]
   * @returns {Promise<unknown>} parsed JSON (null for an empty body)
   */
  async request(method, params = {}, options = {}) {
    const url = this.url(method, params);

    for (let attempt = 0; ; attempt++) {
      // Rebuilt per attempt: an AbortSignal cannot be reused once it has fired.
      const init = {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);

      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new TestRailError(`TestRail timed out after ${Math.round(this.timeoutMs / 1000)}s`);
        }
        const cause = e && e.cause != null ? ` (${String(e.cause.message || e.cause)})` : "";
        throw new TestRailError(`TestRail request failed: ${(e && e.message) || e}${cause}`);
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON — handled below */
      }

      if (!res.ok) throw new TestRailError(errorMessage(res, body, text), res.status);
      if (body === null && text) {
        // A 200 that is not JSON means the URL reached a web page, not the API.
        throw new TestRailError(
          "The instance URL did not return TestRail API JSON — check that it points at a TestRail site"
        );
      }
      return body;
    }
  }

  /**
   * Reads a collection endpoint under both shapes: a bare array (pre-6.7, and
   * endpoints that were never paginated) and the paginated envelope.
   *
   * @param {string} method
   * @param {string} key collection property inside the envelope, e.g. `sections`
   * @param {{ params?: Record<string, string|number|undefined>, paged?: boolean }} [options]
   *   `paged` sends `limit`; endpoints that do not paginate are left alone so an
   *   unexpected parameter can never change their answer.
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async getCollection(method, key, options = {}) {
    const params = options.params || {};
    const paged = options.paged === true;

    const first = await this.request(method, paged ? { ...params, limit: PAGE_LIMIT } : params);
    if (Array.isArray(first)) return first;
    if (!first || typeof first !== "object") return [];

    const rows = Array.isArray(first[key]) ? [...first[key]] : [];
    if (!paged) return rows;

    const limit = Number(first.limit) || PAGE_LIMIT;
    let offset = Number(first.offset) || 0;
    let hasNext = !!(first._links && first._links.next);
    for (let page = 1; hasNext && page < MAX_PAGES; page++) {
      offset += limit;
      const body = await this.request(method, { ...params, limit, offset });
      const chunk = body && Array.isArray(body[key]) ? body[key] : [];
      rows.push(...chunk);
      if (!chunk.length) break;
      hasNext = !!(body._links && body._links.next);
    }
    return rows;
  }

  // ── reads used by the Setup page ─────────────────────────────────────────

  /** Every project the API user can see. Paginated since 6.7. */
  listProjects() {
    return this.getCollection("get_projects", "projects", { paged: true });
  }

  /** Carries `suite_mode`: 1 single suite, 2 single + baselines, 3 multiple suites. */
  getProject(projectId) {
    return this.request(`get_project/${seg(projectId)}`);
  }

  /** One entry for a single-suite project, the real list for `suite_mode = 3`. */
  listSuites(projectId) {
    return this.getCollection(`get_suites/${seg(projectId)}`, "suites");
  }

  getSuite(suiteId) {
    return this.request(`get_suite/${seg(suiteId)}`);
  }

  /**
   * Sections of a project, as a flat list carrying `parent_id` / `depth`.
   * `suiteId` is required only in multi-suite projects.
   */
  listSections(projectId, suiteId) {
    return this.getCollection(`get_sections/${seg(projectId)}`, "sections", {
      paged: true,
      params: suiteId ? { suite_id: suiteId } : {},
    });
  }

  getSection(sectionId) {
    return this.request(`get_section/${seg(sectionId)}`);
  }

  /**
   * Cases of one section (or of a whole suite when `sectionId` is omitted), steps included —
   * `get_cases` returns the full case, so the context picker needs no second call per case.
   * Only the section's own cases: TestRail does not descend into sub-sections here.
   *
   * @param {number|string} projectId
   * @param {{ suiteId?: number|string, sectionId?: number|string }} [scope]
   */
  listCases(projectId, scope = {}) {
    return this.getCollection(`get_cases/${seg(projectId)}`, "cases", {
      paged: true,
      params: { suite_id: scope.suiteId || undefined, section_id: scope.sectionId || undefined },
    });
  }

  /** Case templates of a project — this is what decides the steps field. */
  listTemplates(projectId) {
    return this.getCollection(`get_templates/${seg(projectId)}`, "templates");
  }

  /** Instance-wide case types (Functional, Regression, …). */
  listCaseTypes() {
    return this.getCollection("get_case_types", "case_types");
  }

  /** Instance-wide priorities, each with a `priority_level` used to map our 1-4 scale. */
  listPriorities() {
    return this.getCollection("get_priorities", "priorities");
  }

  /**
   * Case fields with their per-project `configs`. Read once by the import to
   * decide between `custom_steps_separated` and `custom_steps`.
   */
  listCaseFields() {
    return this.getCollection("get_case_fields", "case_fields");
  }

  // ── writes performed by the import ───────────────────────────────────────

  /**
   * Create one case. The section is the container — there is no separate
   * "add to suite" step the way Azure DevOps links a work item into a suite.
   *
   * @param {number|string} sectionId
   * @param {Record<string, unknown>} payload `title` plus whatever the chosen
   *   template accepts: `custom_steps_separated`, `custom_steps`,
   *   `custom_preconds`, `priority_id`, `type_id`, `template_id`, `refs`
   * @returns {Promise<Record<string, unknown>>} the created case, carrying `id`
   */
  addCase(sectionId, payload) {
    return this.request(`add_case/${seg(sectionId)}`, {}, { body: payload });
  }

  /**
   * Create one section. `suite_id` is required on multi-suite projects and
   * harmless elsewhere; `parent_id` nests it, omit it for the suite root.
   *
   * @param {number|string} projectId
   * @param {{ name: string, suite_id?: number|string, parent_id?: number|string, description?: string }} payload
   * @returns {Promise<Record<string, unknown>>} the created section, carrying `id`
   */
  addSection(projectId, payload) {
    return this.request(`add_section/${seg(projectId)}`, {}, { body: payload });
  }
}

module.exports = {
  TestRailClient,
  TestRailError,
  normalizeBaseUrl,
  PAGE_LIMIT,
};
