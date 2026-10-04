#!/usr/bin/env node
/**
 * Preview the related-Jira-issues search the agent will run on Day 1, without
 * generating anything. Lets the web UI show "here is what these keywords find"
 * so the user can tune keywords BEFORE spending an LLM run on generation.
 *
 * Env:
 *   RELATED_ISSUES_KEYWORDS — optional custom keywords (comma/semicolon separated)
 *   JIRA_ISSUE_KEY          — optional; used for the similar-title fallback and key exclusion
 *   RELATED_ISSUES_TYPES    — optional issue type override (same as agent-docs.js)
 *
 * Prints a single JSON line to stdout: { ok, mode, queryWords, jql, issues: [...] }.
 * Exit code 0 even when nothing is found (an empty preview is a valid answer).
 */
require("./config-store.js").loadEnv();

const { JiraClient } = require("./jira-client");
const {
  getTitleSearchWords,
  parseRelatedIssuesKeywords,
  resolveRelatedIssueTypes,
  buildRelatedIssuesJql,
} = require("./related-issues");

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

async function main() {
  const baseUrl = process.env.JIRA_BASE_URL || process.env.BASE_URL;
  const email = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY || "PROJ";
  if (!baseUrl || !email || !token) {
    return fail("Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN). Open the Setup page.");
  }

  const jiraClient = new JiraClient(baseUrl, email, token);
  const issueKey = String(process.env.JIRA_ISSUE_KEY || "").trim();
  const inputKeywords = parseRelatedIssuesKeywords(process.env.RELATED_ISSUES_KEYWORDS || "", 10);

  let queryWords = inputKeywords;
  let mode = "custom keywords";
  if (queryWords.length === 0) {
    if (!issueKey) {
      return fail("Enter keywords, or a Jira key to preview the similar-title fallback.");
    }
    let issue;
    try {
      issue = await jiraClient.getIssue(issueKey);
    } catch (e) {
      return fail(`Could not read ${issueKey}: ${e.message}`);
    }
    queryWords = getTitleSearchWords(issue.fields?.summary || "");
    mode = "similar title";
    if (queryWords.length === 0) {
      return fail(`No significant words in the title of ${issueKey}. Enter keywords instead.`);
    }
  }

  const jql = buildRelatedIssuesJql({
    projectKey,
    issueTypes: resolveRelatedIssueTypes(process.env.RELATED_ISSUES_TYPES || ""),
    queryWords,
    excludeKey: issueKey || undefined,
  });

  let res;
  try {
    res = await jiraClient.searchIssues(jql, ["key", "summary", "status", "issuetype"], 30);
  } catch (e) {
    return fail(`Jira search failed: ${e.message}`);
  }

  const issues = (res.issues || []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || "",
    status: issue.fields?.status?.name || null,
    issueType: issue.fields?.issuetype?.name || null,
  }));

  console.log(JSON.stringify({ ok: true, mode, queryWords, jql, issues }));
}

main().catch((err) => fail(err.message || String(err)));
