# Xray in this project

The fourth test management target, next to Azure DevOps, TestRail and Zephyr Essential. What makes
it different from all three: **an Xray test is a Jira issue**. The app lives in your Jira, the Test
is an issue of type Test in the same project as the story, and its steps live in Xray beside it.

---

## 1. What you need

| | Where it comes from |
|---|---|
| **Client ID** + **Client Secret** | Jira → **Apps → Xray → API Keys**. Create a key for a user allowed to create issues in the project; the pair is shown once. |
| **Jira project key** | The project the Test issues are created in. It must have Xray enabled. |
| **Region** | Xray Cloud runs a global host plus regional twins (`us.`, `eu.`, `au.`). A tenant answers only at its own. |

The Xray keys are **not** your Jira API token — they are Xray's own credential. A Jira token is
still wanted for a different job: resolving the project's numeric id when the folder tree is read
(see §4). That one is optional, and it is **this card's own** — the Xray site does not have to be
the Jira the tickets come from.

---

## 2. Setup

Setup page → **Xray** (under *Test management*) → fill in the four fields → **Test connection** →
**Use this** → **Save**.

**Test connection** buys a token and then reads the project's folder tree, so it answers three
questions at once: are the keys valid, does Jira know that project key, and is Xray actually
switched on for it. It reports `Keys accepted · PROJ · 6 repository folder(s)`.

The settings behind the card, for reference:

| Setting | What it is |
|---|---|
| `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET` | the Xray API key pair |
| `XRAY_PROJECT_KEY` | the Jira project the Test issues go to |
| `XRAY_JIRA_BASE_URL`, `XRAY_JIRA_EMAIL`, `XRAY_JIRA_API_TOKEN` | the Jira Xray lives in |
| `XRAY_BASE_URL` | region: `https://xray.cloud.getxray.app` or a regional twin |
| `XRAY_FOLDER_PATH` | the root folder, `/` by default |
| `XRAY_CREATE_MISSING_FOLDER` | file each ticket in its own folder under that root |
| `XRAY_LINK_ISSUES` | a real Jira link back to the story, not only a label |
| `XRAY_LINK_TYPE` | empty: Test, else Tests, else Relates |
| `XRAY_SYNC_APPROVED_CSV` | Auto-import approved CSV |

---

## 3. What the importer writes

One GraphQL call per test case — the issue, its steps and its folder in a single mutation:

| Mutation | Carries |
|---|---|
| `createTest` (`testType: Manual`) | `steps[{action, data, result}]`, `folderPath`, `jira.fields` (summary, project, labels) |
| `createTest` (`testType: Cucumber`) | `gherkin`, the same `folderPath` and `jira.fields` |

A case whose steps are written as Gherkin becomes a **Cucumber** test and the rest become
**Manual** ones — decided per case, so one CSV can hold both. That is the same split the TestRail
and Zephyr importers make, with a third syntax.

**The ticket is a label *and* a link.** The created Test carries `PROJ-123` and the Area Path as
Jira labels — labels cannot contain spaces, so "Customer Portal" is written `Customer_Portal`. On top
of that, `XRAY_LINK_ISSUES` (default on) posts a real Jira issue link from each Test back to the
story, which is what the Zephyr importer does through Zephyr's own endpoint. Here both ends are
ordinary Jira issues, so it is an ordinary Jira link and the Xray API is not involved: the link
type is read once per run, preferring `Test`, then `Tests`, then `Relates`, and `XRAY_LINK_TYPE`
overrides that. A link that fails is reported against its test; the test is kept, because the test
is what was approved.

**Preconditions stay as step 1.** In Xray a Precondition is its own issue type, linked to the test.
Creating one per case is a second artefact nobody approved, so the CSV's preconditions row is filed
as the first step — which is where it already was. A **Cucumber** test has no step grid to leave
them in, and no precondition field of the kind TestRail and Zephyr lift them into, so there they
ride at the top of the scenario as Gherkin `#` comments: valid syntax, visible in the editor, and
no invented step.

**Priority is not set.** A Jira priority is a per-project name ("High", "Major", …) and a wrong one
fails the whole create. The CSV's 1/2 stays in the CSV.

---

## 4. Where tests land

`folderPath` is a path in the project's **Test Repository**, and `/` is its root.

**The folder is matched per ticket**, by the same scoring the Azure DevOps suite, the TestRail
section and the Zephyr folder use — a folder named exactly `PROJ-123` beats one that merely mentions
it. If nothing matches and `XRAY_CREATE_MISSING_FOLDER` is not `false`, one is created under the
configured root, named **`PROJ-123 Story summary`** — the same name the Zephyr folder and the
TestRail section get, from the same helper, with the summary read out of the CSV's file name.

The folder is created explicitly rather than left to `createTest`: that mutation takes a
`folderPath`, but Xray does not document it as creating one, and a test that quietly lands at the
root instead of its ticket's folder is the kind of miss nobody notices until the repository is full
of them.

Nothing here is fatal. Where TestRail can refuse to import without a section, this always has
somewhere to put a test — a tree that cannot be read, a folder that cannot be created, or a project
id that cannot be resolved costs the filing, not the run, and each says so on stdout. The Manual
Import step passes a folder outright and skips the match.

Reading that tree needs the **numeric Jira project id**, which Xray's `getFolder` takes instead of
the key, and no Xray query turns one into the other. So it is read from Jira, with:

1. **This card's own Jira fields** (`XRAY_JIRA_BASE_URL` + email + token), read as a set and
   required on the Setup page. This is what makes Xray work on a different Jira site — a trial, a
   second account — than the one issues are read from.
2. **The main Jira card**, when the card's own site is empty. Right when Xray sits in the same
   Jira as the tickets — but the card asks for its own rather than assuming.

There was briefly a third way — a numeric id typed straight into the card, skipping Jira entirely.
It went away once the Jira fields became required: two mechanisms for one value, one of them a
number nobody remembers, is a field that only ever raises the question of whether to fill it in.

Getting this wrong used to be silent. Now the failure names the host it asked and which card's
credentials it used — `https://other.atlassian.net has no project "XSP" — the Jira card points at a
different site than Xray does`. When the id cannot be resolved the import still runs: it files
under the configured root and says so on stdout.

---

## 5. Two API shapes worth knowing

Both cost time when they are met for the first time in a debugger:

1. **The token comes back as a quoted string.** `POST /api/v1/authenticate` answers `"eyJhbGciOi…"`
   — a JSON string, not an object. It is good for 24 hours; this project buys one per run and
   renews it when a call comes back 401.
2. **GraphQL reports failures inside a 200.** A missing project or a malformed mutation arrives as
   HTTP 200 with an `errors` array, so a client that only checks the status reports success on a
   failed write. Everything here reads the body first.

---

## 6. Files

| File | Role |
|---|---|
| [xray-client.js](xray-client.js) | auth, GraphQL, the folder tree, `createFolder`, `createTest` for Manual and Cucumber |
| [xray-sync-csv.js](xray-sync-csv.js) | the importer: folder match and creation, step mapping, labels, issue links, CLI |
| [ado-sync-csv.js](ado-sync-csv.js) | shared with it: the CSV parser and the Jira-key container match |
| [tms-export-csv.js](tms-export-csv.js) | the way back: tests ticked in the Update page's context panel ("Use selected as CSV") → the CSV the Update flow reads; handles old tests too — linked Precondition issues, Generic tests |
| [config-store.js](config-store.js) | the `xray` card, `xrayClientFrom()`, `resolveXrayProjectId()`, `listXrayFolders()`, `testConnection("xray")` |
| [agent-docs.js](agent-docs.js) | `TMS_IMPORTERS.xray` — routes the approved CSV here when Xray is in use |
| [web-ui-server.js](web-ui-server.js) | `POST /__da/xray/folders` for the Manual Import picker |
| [web/tms-target-panel.js](web/tms-target-panel.js) | the folder picker, one level like Zephyr's |
