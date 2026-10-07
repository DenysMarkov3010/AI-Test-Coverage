# Zephyr Essential integration

Status: **working end to end.** The Setup page talks to Zephyr Essential Cloud,
and [zephyr-sync-csv.js](zephyr-sync-csv.js) writes the approved CSV into it —
the third importer alongside Azure DevOps and TestRail, with the same Jira-key
folder match and the same `{ created, errors, usage }` result.

The folder picked here is the root a run files into; the per-ticket folder
inside it is meant to be matched from the Jira key at import time, the way the
Azure DevOps suite and the TestRail section are, so it is not a setting.

---

## 1. Which Zephyr this is — and which *version* of it

Two traps sit on top of each other here, and both of them produce a 401 that
looks like a typo.

**Trap one: the brand covers several products.** SmartBear has renamed this
family twice, and the old names are still all over the internet:

| Product (current name) | Formerly | Supported here |
|---|---|---|
| **Zephyr Essential Cloud 2.0** | — (this is the new one) | **yes** |
| Zephyr Essential Cloud 1.0 | Zephyr Squad / Zephyr for Jira | no |
| Zephyr Essential Data Center | Zephyr Squad Server | no |
| Zephyr | Zephyr Scale / TM4J | no |
| Zephyr Enterprise | — | no |

**Trap two: "Zephyr Essential" alone does not identify an API.** SmartBear
ships two experiences under that one name, and they have nothing in common:

| | **2.0 — New Experience** (this card) | 1.0 — Legacy Experience |
|---|---|---|
| Base URL | `https://prod-api.zephyr4jiracloud.com/v2` | `https://prod-api.zephyr4jiracloud.com/connect` |
| Auth | one bearer token | access key + secret key, signing every request |
| Where the credential lives | Jira **profile menu → Zephyr Essential API Access Tokens** | **Apps → Zephyr Squad → API Keys** |
| What the screen looks like | a table of **Access Tokens**: ID, Valid From, Valid To, Revoke | a **pair of keys** and a Regenerate button |
| A test case is | a Zephyr entity, addressed by project key | a Jira issue of type Test |

**The token screen is how you tell them apart.** If yours lists Access Tokens
with validity dates and a Revoke button, you are on 2.0 and this card is right.
If it shows an access key next to a secret key, you are on 1.0 and this card
cannot talk to it — that is a different client, not a different setting.

Cloud 2.0 is therefore wired in rather than chosen: the base URL is a constant
in [zephyr-client.js](zephyr-client.js) and there is no deployment field. A
switch with one position is not a decision anybody makes.

## 2. Before anything works: create a token

Zephyr Essential 2.0 authenticates with one bearer token — there is no email or
password field, because the token carries the identity of the Jira account that
created it.

1. In Jira, click your **profile picture** → **Zephyr Essential API Access
   Tokens** (your own profile menu, not a project and not Atlassian's
   *Personal Access Tokens* page)
2. **Create access token**, and copy the value it shows — it is shown once
3. paste it into the Setup page

Three consequences worth knowing up front:

- **The UUID left behind in the list is not the token.** That column is
  *Access Token ID*: it exists so you can tell rows apart and press Revoke.
  Pasting it produces a 401. If the real value was not copied, create a new
  token — or revoke the old one first, if you want the list to stay tidy.
- The token inherits the Jira permissions of whoever made it. A **403** is a
  Jira project permission, not a Zephyr setting.
- Tokens **expire** — the list shows Valid From and Valid To. A **401** on a
  token that worked last month usually means it has to be recreated, not that
  it was typed wrong.

It is stored in `config.local.json` (git-ignored, chmod 600), never in the repo.

## 3. Fields on the Setup page

Three fields, all of them required, and every one load-bearing:

| # | Field | Key | Where the value comes from |
|---|---|---|---|
| 1 | API token * | `ZEPHYR_API_TOKEN` | Jira profile menu → Zephyr Essential API Access Tokens |
| 2 | Project * | `ZEPHYR_PROJECT_KEY` | live list (`GET /projects`) |
| 3 | Folder * | `ZEPHYR_FOLDER_ID` | live list (`GET /folders?folderType=TEST_CASE`) |

`*` = required before the card reads **Configured**. There is no import
switch: with Zephyr Essential In use and these fields filled, **Automate
import** always imports.

**No Jira credentials.** This is the difference 2.0 makes: a test case is a
Zephyr entity created by `POST /testcases`, not a Jira issue, so nothing here
needs a Jira login. Linking a case back to its ticket is one optional call
afterwards (`POST /testcases/{key}/links/issues`).

**What is deliberately not a field.** Everything with one defensible answer is
a constant instead of a question:

| Not asked | Because |
|---|---|
| Deployment / base URL | Cloud 2.0 is one fixed endpoint for every tenant |
| Status for new cases | `POST /testcases` defaults to the project's own default, usually Draft |
| Priority mapping | the CSV's 1-4 scale maps onto the project's priorities at import time |
| Sub-folder per ticket | matched from the Jira key at import time, like the Azure DevOps suite |

**The project is stored as a key, not an id.** Every Zephyr read is scoped by
`projectKey=PROJ`, so that is what the picker saves — the one place this card
differs from the Azure DevOps and TestRail cards, which store numeric ids.

The two dropdowns cascade: pick a project and the folder list re-reads itself
for it. Nothing is saved until you press Save; the lists load from a token
typed into the form, so they fill in before the first save.

## 4. What the live lists actually show

| Picker | Endpoint | What you see |
|---|---|---|
| Project | `GET /projects` | the **key** only. Zephyr's project list carries no display name — the Jira project id is in the tooltip to tell similar keys apart. Only projects Zephyr is enabled for appear. |
| Folder | `GET /folders?projectKey&folderType=TEST_CASE` | the full path, `Regression / Smoke / Web Store`. Zephyr returns the tree flat with a `parentId`; the path is rebuilt locally by `buildFolderPaths()`, because three folders called "Smoke" are not a choice anyone can make. |

Both are paginated — the client pages through `{ values, isLast, next }` for
each, so a project with 200 folders shows 200 folders rather than the first
page of them.

## 5. Which provider a run imports into

Every provider card can be configured at once. The one marked **In use** is the
destination of a run (`TMS_PROVIDER`):

| Toggle | `TMS_PROVIDER` | Effect |
|---|---|---|
| Nothing in use | empty (default) | No import; the import steps stay disabled until a provider is picked |
| Azure DevOps in use | `ado` | Automate import imports into Azure DevOps |
| TestRail in use | `testrail` | Automate import imports into TestRail |
| Zephyr Essential in use | `zephyr` | Automate import imports into Zephyr Essential |
| Xray in use | `xray` | Automate import imports into Xray — see [XRAY.md](XRAY.md) |

### What the importer writes

Three calls per case, and that is not a choice: `POST /testcases` takes no
steps, and the steps endpoint is keyed by the case key that first call returns.

| # | Call | Carries |
|---|---|---|
| 1 | `POST /testcases` | `projectKey`, `name`, `folderId`, `priorityName`, `precondition`, `labels` |
| 2 | `POST /testcases/{key}/teststeps` — or `/testscript` for a scenario | the step grid, or the Gherkin with `type: "bdd"` |
| 3 | `POST /testcases/{key}/links/issues` | the ticket, by Jira's **numeric** issue id |

A case has steps *or* a script, never both, so a Gherkin design skips the step
grid entirely — the same split TestRail makes between its BDD field and its
ordinary steps.

**Preconditions move.** An agent CSV keeps them as step 1 with expected "—",
which is an Azure DevOps convention: it has no field for them. Zephyr has a real
`precondition`, so the row is lifted into it rather than filed as a step.

**Those fields are HTML.** `precondition`, and both step cells, are a WYSIWYG
editor: a cell posted as plain lines comes back inside one paragraph with the
newlines intact, and the browser collapses them into spaces — which is what read
as one run-on line. So the import writes real markup, the same rules TestRail
needs (section 8 of TESTRAIL.md), shared with it in
[tms-rich-text.js](tms-rich-text.js):

| Cell | Written as |
|---|---|
| Preconditions | `<ul><li>one thesis</li>…</ul>` |
| A step whose cell is a "- " list | `<ul>` |
| Any other multi-line cell — a BDD `Then … / And …` block | `<br>`-joined lines |
| A single-line cell | escaped text, no wrapper |
| Step Expected of "—" | empty, the way a checklist item has no expectation |

Anything out of the CSV is escaped first, or a step reading `value < 5` is
swallowed as an unknown tag. The BDD **script** is the one field that stays
plain: it goes through Zephyr's Gherkin validator, which `<br>` would fail.

**Priority is matched by name.** Zephyr takes `priorityName` and lets a project
rename its priorities, so the list is read once per run: an exact name match
wins, then the stock 1→High / 2-3→Normal / 4→Low map, then position.

**Area Path becomes a label**, next to the Jira key. There is no second axis to
put it on, and a custom field would be one more thing to configure.

**The folder is matched per ticket**, by the same scoring the Azure DevOps suite
and the TestRail section use — a folder named exactly `PROJ-123` beats one that
merely mentions it. If nothing matches and `ZEPHYR_CREATE_MISSING_FOLDER` is not
`false`, one is created at the project root named **`PROJ-123 Story summary`** —
the key first, because that is what the next run matches on, then the story
summary read back from the CSV's own file name (`"<story summary> (PROJ-123).csv"`),
which costs no Jira call. The TestRail section is named the same way, by the same
helper. The Manual Import step passes a folder outright and skips the match.

## 6. Connection test

**Test connection** on the card runs `GET /healthcheck` first, then the saved
targets:

| What it says | What it means |
|---|---|
| `Token accepted · 12 projects available` | the token works; no project picked yet |
| `Token accepted · project PROJ: 8 folders · folder Smoke` | everything resolves |
| `Token accepted · project PROJ: 8 folders · folder 777 is not in this project` | a folder that was deleted or belongs elsewhere |
| `Token accepted · project NOPE unreachable (…)` | the token is fine, the project key is not |
| `API token rejected (401) …` | expired, mistyped — or the Access Token **ID** was pasted instead of the token |

Splitting the healthcheck from the project read is the point: without it a
typo'd project key reads exactly like a bad token.

## 7. Reading cases back for Update test design

On the Update page, tick the cases to update in **Add context from Zephyr Essential** — any folders,
old hand-written cases included — and click **Use selected as CSV**. That is the importer run
backwards: each case is read with its steps (or its BDD script) and written as one agent CSV into
`Updated test cases`. The `precondition` field goes back to step 1 with expected "—", `<ul>` cells
go back to "- " lines, the priority name goes back to 1-4, the non-key label becomes the Area Path,
and a step that calls another case becomes "Call test case PROJ-T9". The ID column holds the Zephyr
key (`PROJ-T12`). Read-only — see [tms-export-csv.js](tms-export-csv.js). From the CLI, for cases
this tool filed: `npm run tms:export-csv -- --jira-key PROJ-123`.
