/**
 * Guard against redaction-style placeholders leaking from the LLM into approved content.
 *
 * Models sometimes emit typed PII placeholders — [PERSON_NAME], [EMAIL_ADDRESS], [DATE_OF_BIRTH] —
 * wherever they have no concrete value. That vocabulary comes from de-identification tooling
 * (Presidio / Cloud DLP infoTypes) in their training data, not from this project: nothing in the
 * prompts, the format reference, or the Jira/Confluence/Figma context ever asks for it. Left alone
 * those tokens travel straight through the Jira comment into the CSV and then into Azure DevOps,
 * and the Update flow copies them again because it reuses the previous CSV as its base.
 *
 * TEST_CASE_FORMAT.md defines the placeholder convention the prompts must use: lowercase words in
 * angle brackets (<user>, <item>, <amount>), and the targets below stay domain-neutral so they read
 * naturally in any product's test cases. So every known redaction
 * token is rewritten to that convention and reported, while any other unexpected [UPPER_SNAKE]
 * token is only reported — it might be a real UI label such as [OK], which must not be rewritten.
 */

/** Known redaction / de-identification infoTypes → this project's placeholder convention. */
const REDACTION_PLACEHOLDERS = {
  // People
  PERSON: "<user>",
  PERSON_NAME: "<user>",
  NAME: "<user>",
  FULL_NAME: "<user>",
  FIRST_NAME: "<first name>",
  GIVEN_NAME: "<first name>",
  LAST_NAME: "<last name>",
  SURNAME: "<last name>",
  PATIENT: "<user>",
  PATIENT_NAME: "<user>",
  DOCTOR_NAME: "<user>",
  PROVIDER_NAME: "<user>",
  // Contact details and credentials
  EMAIL: "<email>",
  EMAIL_ADDRESS: "<email>",
  PHONE: "<phone>",
  PHONE_NUMBER: "<phone>",
  USERNAME: "<username>",
  USER_NAME: "<username>",
  PASSWORD: "<password>",
  // Identifiers
  ID_NUMBER: "<id>",
  MRN: "<record number>",
  MEDICAL_RECORD_NUMBER: "<record number>",
  PATIENT_ID: "<user id>",
  SSN: "<ssn>",
  US_SSN: "<ssn>",
  PASSPORT: "<passport number>",
  DRIVER_LICENSE: "<driver license>",
  INSURANCE_ID: "<insurance id>",
  POLICY_NUMBER: "<policy number>",
  ACCOUNT_NUMBER: "<account number>",
  BANK_ACCOUNT: "<account number>",
  CREDIT_CARD: "<card number>",
  CREDIT_CARD_NUMBER: "<card number>",
  IBAN_CODE: "<iban>",
  // Places and organisations
  ADDRESS: "<address>",
  STREET_ADDRESS: "<address>",
  LOCATION: "<address>",
  CITY: "<city>",
  ZIP: "<postal code>",
  POSTAL_CODE: "<postal code>",
  ORG: "<organization>",
  ORGANIZATION: "<organization>",
  CLINIC: "<organization>",
  // Dates, demographics, network
  DATE: "<date>",
  DATE_TIME: "<date>",
  TIME: "<time>",
  DATE_OF_BIRTH: "<date of birth>",
  DOB: "<date of birth>",
  AGE: "<age>",
  GENDER: "<gender>",
  IP_ADDRESS: "<ip address>",
  URL: "<url>",
  // Generic redaction markers
  REDACTED: "<redacted>",
  PII: "<redacted>",
  PHI: "<redacted>",
};

/** [UPPER_SNAKE_CASE] tokens — the shape every de-identification tool uses. */
const PLACEHOLDER_TOKEN_RE = /\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\]/g;

const CONTEXT_CHARS = 60;

function snippetAround(text, index, length) {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + CONTEXT_CHARS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite known redaction placeholders in a single string.
 * @returns {{ value: string, hits: Array<{ token: string, replacement: string|null, snippet: string }> }}
 */
function scrubString(text, path, hits) {
  return {
    value: text.replace(PLACEHOLDER_TOKEN_RE, (match, token, offset) => {
      const replacement = Object.prototype.hasOwnProperty.call(REDACTION_PLACEHOLDERS, token)
        ? REDACTION_PLACEHOLDERS[token]
        : null;
      hits.push({
        path,
        token: match,
        replacement,
        snippet: snippetAround(text, offset, match.length),
      });
      // Unknown tokens are reported but left untouched — they may be genuine UI labels.
      return replacement === null ? match : replacement;
    }),
  };
}

/**
 * Deep-walk any LLM result (string / array / plain object) and rewrite known redaction
 * placeholders. Non-container values are returned untouched.
 * @param {*} input
 * @param {string} [path] - dotted path used in the console report
 * @param {Array} [hits] - accumulator, created when omitted
 * @returns {{ value: *, hits: Array<{ path: string, token: string, replacement: string|null, snippet: string }> }}
 */
function scrubRedactionPlaceholders(input, path = "", hits = []) {
  if (typeof input === "string") {
    return { value: scrubString(input, path || "(root)", hits).value, hits };
  }
  if (Array.isArray(input)) {
    const value = input.map((entry, i) => scrubRedactionPlaceholders(entry, `${path}[${i}]`, hits).value);
    return { value, hits };
  }
  if (isPlainObject(input)) {
    const value = {};
    for (const [key, entry] of Object.entries(input)) {
      value[key] = scrubRedactionPlaceholders(entry, path ? `${path}.${key}` : key, hits).value;
    }
    return { value, hits };
  }
  return { value: input, hits };
}

/**
 * Print a console report for the placeholders found. Rewritten and untouched tokens are
 * listed separately so the QA engineer knows which cells still need a real value.
 */
function reportRedactionPlaceholders(hits, contextLabel) {
  if (!hits.length) return;
  const label = contextLabel ? ` in ${contextLabel}` : "";
  const rewritten = hits.filter((h) => h.replacement !== null);
  const unknown = hits.filter((h) => h.replacement === null);

  if (rewritten.length) {
    console.log(
      `⚠️  Replaced ${rewritten.length} redaction placeholder(s)${label} — the LLM had no concrete value there, so review each one:`
    );
    for (const hit of rewritten) {
      console.log(`     ${hit.token} → ${hit.replacement}  [${hit.path}]`);
      console.log(`       ${hit.snippet}`);
    }
  }
  if (unknown.length) {
    console.log(
      `ℹ️  Found ${unknown.length} other bracketed token(s)${label}, left as-is (may be real UI labels):`
    );
    for (const hit of unknown) {
      console.log(`     ${hit.token}  [${hit.path}]`);
      console.log(`       ${hit.snippet}`);
    }
  }
}

/**
 * Scrub in one call. Use this right after parsing an LLM response, so the content the QA engineer
 * approves in Jira is already clean.
 *
 * Silent on purpose: the substitution is a mechanical cleanup of a model artifact, not something
 * the reader of a run log has to act on, and listing every hit buried the lines that do matter.
 * Set DEBUG_PLACEHOLDER_GUARD=true to print what was replaced when diagnosing the model's output.
 *
 * @param {*} parsed - parsed LLM result
 * @param {string} contextLabel - e.g. "checklist for PROJ-123"
 * @returns {*} the scrubbed result
 */
function guardLlmResult(parsed, contextLabel) {
  const { value, hits } = scrubRedactionPlaceholders(parsed);
  if (process.env.DEBUG_PLACEHOLDER_GUARD === "true") {
    reportRedactionPlaceholders(hits, contextLabel);
  }
  return value;
}

module.exports = {
  REDACTION_PLACEHOLDERS,
  PLACEHOLDER_TOKEN_RE,
  scrubRedactionPlaceholders,
  reportRedactionPlaceholders,
  guardLlmResult,
};
