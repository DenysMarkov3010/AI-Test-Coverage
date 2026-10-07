# AI Test Coverage — QA test generation from Jira

A small Node.js tool for QA engineers. It reads a Jira issue, asks an LLM to draft a **checklist** or **test cases**, lets you edit *and approve* that draft in the Web UI, and then builds a CSV holding exactly the rows you approved. That CSV can be imported as test cases into the test management system you use — **Azure DevOps**, **TestRail**, **Zephyr Essential** or **Xray**. The import is optional.

> **New here? Read this file first, then [FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) when you need the full step-by-step.**

## Who is this for

- QA engineers who want a first-draft test coverage they can edit, instead of writing from scratch.
- Anyone who wants approved test cases to land in Azure DevOps, TestRail, Zephyr Essential or Xray without retyping them.

You do **not** need to understand the internals to use it — the **Web UI** hides all the commands.

## What you need before you start

| Requirement | Where to get it / how to check |
|---|---|
| **Node.js 18+** | `node -v`. Download from <https://nodejs.org> if missing. |
| **Jira account** + **API token** | <https://id.atlassian.com/manage-profile/security/api-tokens> |
| **OpenRouter API key** (LLM provider) | <https://openrouter.ai/keys>. Pay-as-you-go. |
| **Your Jira project key** | The 3–4-letter prefix on your tickets (e.g. `PROJ` if your keys look like `PROJ-1234`). |
| A test management system | Optional — only if you want the approved cases imported. Azure DevOps, TestRail, Zephyr Essential or Xray; what each one needs is in its own doc (see the [Documentation map](#documentation-map)). |
| **Google Chrome** (macOS) | The Desktop shortcut opens the Web UI in Chrome. Also what renders a prototype link, if you use one — see [PROTOTYPE.md](PROTOTYPE.md). |

## First-time setup (5 minutes)

1. **Open the project folder** in a terminal. This is the folder that contains `package.json` and `agent-docs.js`.

   - macOS / Linux: `cd /path/to/AI_Test_Coverage`
   - Windows: `cd C:\path\to\AI_Test_Coverage`

   > **Important:** if you see `npm error code ENOENT — Could not read package.json`, you are one folder above the correct one. `cd` one level deeper.

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Start the Web UI.** One script starts the server and opens the page in the browser:

   - macOS: `bash scripts/launch-ai-test-coverage.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1`

   It runs `npm run web` in its own window (a new Terminal window on macOS, a minimized one on
   Windows) unless the server is already up, waits for it, and opens <http://127.0.0.1:3847/> in
   Chrome — or the default browser when Chrome is missing. You should see the AI Test Coverage home
   page. Keep that server window open while you work; close it (or press `Ctrl+C` in it) to stop.

   On Linux, or to do it by hand: `npm run web`, then open <http://127.0.0.1:3847/>.

4. **Open the [Setup](http://127.0.0.1:3847/setup.html) page** (linked from the home page) and fill in, at minimum:

   | Card | Fields |
   |---|---|
   | **Jira** | base URL, account email, API token, project key |
   | **AI model (OpenRouter)** | API key |

   Each card shows a green **✓ Configured** badge once its required fields are filled, and has a
   **Test connection** button that verifies the credentials against the real service before you run anything.

   The cards under *Test management* — **Azure DevOps**, **TestRail**, **Zephyr Essential**, **Xray** — are
   optional. Fill in the one your team uses and mark it **In use**; several can be configured, and the
   one In use is where every run imports.

   The **Format examples** card (under *Generation*) holds the worked test cases, checklists and BDD
   scenarios the model is shown as the format to copy when it generates new ones — one set, shared by
   every test management system. Add them straight from the provider In use (**Add from ‹provider›…**:
   pick a suite, section or folder and tick the cases), from a CSV (**Add from CSV…** opens the native
   file dialog), by pasting CSV text, or by hand — a BDD example is typed as plain Gherkin. Test cases
   and checklists go to the standard prompt, BDD scenarios to the Gherkin one. Toggle any example in or
   out of the prompt, and use **Preview what the model sees** to read the exact blocks that get
   injected. They are stored in `test-case-examples.local.json` (git-ignored).

5. Click **Save all changes**. Values are written to `config.local.json` in the project folder — local to your
   machine, git-ignored, and never shown back to the browser once stored (secrets are write-only).

> **Someone shared their config with you?** Click **Import JSON** on the Setup page and pick the file —
> every non-secret setting is filled in, and you only add your own tokens.

That's it. After the first start you'll also see a Desktop shortcut named **AI Test Coverage** (macOS and Windows) — double-click it next time instead of running anything. It does exactly what the launch script does.

## Using it: the easy path (Web UI)

The home page has three cards:

| Card | What it does |
|---|---|
| **Create new test design** | Generates a fresh checklist or test cases for a Jira issue, then (after you approve the rows in the review panel) builds the CSV. |
| **Update test design** | Re-generates an already-existing CSV when requirements change. See [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md). |
| **Cover a bug** | Closes a coverage gap, in two steps: paste the bug that got through, get **one** regression case for it, then import it into the container you pick in the test management system In use. No related-issue context, no Jira comment, no approval marks — the import is the decision. |

A typical "Create" run, step by step:

1. Click **Create new test design**.
2. In **Project folder** click **Browse** and pick the folder that contains `agent-docs.js`. This is the same folder you started `npm run web` from.
3. Type the Jira issue key (for example, `PROJ-1234`).
4. Choose **Checklist** or **Test cases**.
5. Click **Run Day 1**. Nothing is posted yet: the draft opens in the review panel.
6. Read each row and edit it in place. Mark the ones you want with **Approve** — nothing is approved
   to begin with, and **Approve all** does the whole block once you have read it.
7. Click **Submit to Jira**. The approved rows — and only those — are written as the CSV, which is
   attached to the Jira issue you typed, with a comment linking it. With **Azure DevOps** In use it goes
   to the story's **Test design** QA sub-task instead (see [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)).
   Unapproved rows are left out; nothing else is posted.
8. Pick **Automate import into ‹your provider›** with the same Jira key. It takes the CSV attached
   in step 7 and creates the test cases. No Jira comment is read, and no approval is typed anywhere.
   Prefer to choose the destination yourself? **Manual Import into ‹your provider›** takes the same CSV
   into a container you pick on the page.

The output CSV is saved to `OneDrive/Desktop/Checklists and Test cases` in your home folder; set the `CHECKLIST_OUTPUT_DIR` environment variable to use another folder. The same file is also attached in Jira, as described in step 7.

### Cover a bug (nothing written to Jira)

Use this when a bug reached testing or production and no test case covered that edge case — you want the one regression case that closes the gap, straight in the test management system, with no Jira review in between:

The page runs as two steps, picked from the **Steps** dropdown. Step 2 stays disabled until step 1 has produced a test case.

**Step 1 — Generate regression case from bug**

1. Click **Cover a bug**.
2. Pick the project folder, exactly as above.
3. Paste the bug link — a `…/browse/PROJ-1234` URL, a board link with `?selectedIssue=`, or the bare key. Any Jira issue type works; a bug is simply the usual case.
4. Choose **Standard** or **BDD (Gherkin)**. There is no count to pick: one bug gives exactly one test case — the whole coverage for that ticket, written as a single deep case rather than a suite of shallow ones.
5. Click **Generate**. Only the ticket in the link is read: no related Jira issues, no linked Confluence pages. The case describes that defect and nothing around it.

**Step 2 — Import to ‹your provider›**

6. The page moves here by itself once the case exists. Edit it in place — the same editor, per-step editing and *Regenerate all* as the other two flows.
7. Pick the destination. What you pick follows the **In use** toggle on the Setup page, which also names this step:

   | In use | Destination |
   |---|---|
   | Azure DevOps | Test Plan → Test Suite |
   | TestRail | Suite → Section |
   | Zephyr Essential | Folder |
   | Xray | Test Repository folder |

8. Click **Import**. The case is created in the container you picked, and the CSV behind it is kept in a `From issue` sub-folder of the checklist output folder.

The ticket in the link is the one that gets read: unlike **Create**, this flow never climbs to a parent Epic, and it needs no **Test design** QA sub-task (which Create requires for Azure DevOps), because nothing is written to Jira.

For every option and every CLI command, see **[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)**.

## Using it: the advanced path (CLI)

A few shortcuts you'll use most often:

```bash
# Generate a checklist for one ticket
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false node agent-docs.js

# Import the CSV that was approved in the review panel and attached to the ticket
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true  node agent-docs.js
```

PowerShell users need to set environment variables on separate lines — see FULL_FLOW_GUIDE.md.

## Where settings live

Everything is configured on the **Setup** page in the Web UI. Nothing has to be hardcoded in a file.

| Group | Cards |
|---|---|
| **Required** | Jira · AI model (OpenRouter) |
| **Generation** | Format examples — the house-style examples every generation follows (test cases, checklists, BDD) |
| **Test management** | Azure DevOps, TestRail, Zephyr Essential, Xray — all four import the approved CSV; the one marked **In use** is the target |
| **Extra context sources** | Confluence · Figma · existing test cases from the provider In use (the **Add context from ‹provider›** panel — see [FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) §2) |

Each test management card has its own required fields and a **Test connection** button; the provider
docs ([ADO_TEST_PLANS.md](ADO_TEST_PLANS.md), [TESTRAIL.md](TESTRAIL.md), [ZEPHYR.md](ZEPHYR.md),
[XRAY.md](XRAY.md)) walk through them. For example, the **Azure DevOps** card needs only four fields
for the import to work: organization, project, PAT, and the **Active Test Plan**. The two plan fields are dropdowns — paste the PAT and the
list of Test Plans in that project loads straight away (active plans first), so you pick a plan by name
instead of hunting for its id. Everything else in the card has a working default.

When a setting is read, the first value found wins:

1. **The environment** — a variable exported in your shell, or one the Web UI sets for a single run
   (the ticket key you typed, the generation mode you picked).
2. **`config.local.json`** — what you saved on the Setup page.

So a one-off `ADO_PROJECT=Other npm run ado:list-plans` overrides the Setup page for that one command.

`config.local.json` is git-ignored and written with owner-only permissions, so it never travels with the repo.
The same holds for `test-case-examples.local.json`, the format examples curated on the Setup page.

**Sharing this project with someone else:**

1. **Export JSON** on the Setup page — every secret is stripped, so the file is safe to send.
2. They clone the project, run `npm run web`, open Setup and click **Import JSON**.
3. Every URL, project key and default is filled in; they add their own tokens and press Save.


## Documentation map

| File | When to open it |
|---|---|
| **README.md** (this file) | Start here. Installation, quick walk-through, troubleshooting. |
| **[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)** | The step-by-step operational guide — every command, every option, scheduling. |
| **[UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)** | What to do when requirements change and you need to update an existing CSV. |
| **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** | Azure DevOps integration — Test Plans, suite linking, CSV sync, tag export, the Test design sub-task. |
| **[TESTRAIL.md](TESTRAIL.md)** | TestRail integration — enabling the API, the Setup fields, sections, BDD template. |
| **[TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)** | The exact CSV format the agent produces (with examples). Also has the Cursor / MCP prompts. |
| **[OPENROUTER.md](OPENROUTER.md)** | Choosing and configuring the LLM model. |
| **[PROTOTYPE.md](PROTOTYPE.md)** | Reading a live clickable prototype as design context — the *Read prototype* switch, what gets crawled, and the tuning knobs. |
| **[XRAY.md](XRAY.md)** | Importing into Xray — a test is a Jira issue, and what follows from that. |
| **[ZEPHYR.md](ZEPHYR.md)** | Zephyr Essential integration — which Zephyr this is and which *version* of it (the token screen tells them apart), the API token, the Setup fields and the live pickers. |
| **[TMS_INTEGRATIONS.md](TMS_INTEGRATIONS.md)** | How the four test management providers compare: what is shared, and what each one does differently. |

## Desktop shortcut

`npm run shortcut` creates a Desktop shortcut named **AI Test Coverage**. Double-clicking it starts the Web UI (if it is not running yet) and opens the page in your browser. It is created automatically the first time the server starts and is a one-time, idempotent action.

The shortcut does what the launch script does (the Windows one runs it; the macOS app carries the same steps), so you can also run the script directly:

- macOS: `bash scripts/launch-ai-test-coverage.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1`

On Linux there is neither a shortcut nor a launcher: run `npm run web` and open <http://127.0.0.1:3847/>.

- **Windows:** `.lnk` file with the project's icon.
- **macOS:** `.app` bundle that opens the page in **Google Chrome** (falls back to your default browser if Chrome is not installed).

If the shortcut stops working after you move the project folder, just run `npm run shortcut` again from the new location.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `npm error code ENOENT — Could not read package.json` | You're not in the project folder. `cd` into the folder that contains `package.json` and `agent-docs.js`. |
| Web UI shows **Folder must contain agent-docs.js (AI Test Coverage root)** | In **Browse**, pick the folder that contains `agent-docs.js` — usually `…/AI Test Coverage/`, **not** its parent. |
| Web UI does not load / port is already in use | Use a different port: `WEB_UI_PORT=4000 npm run web`. |
| Cursor's Simple Browser cannot reach 127.0.0.1:3847 | Cursor's built-in browser sometimes blocks localhost. Open the URL in regular Chrome or Edge. |
| macOS Desktop shortcut does nothing on click | Check `/tmp/ai-test-coverage.log` for errors. Most often: the project folder was moved — rebuild the shortcut with `npm run shortcut` from the new location. |
| A key you saved on **Setup** seems ignored | Something higher in the precedence list is winning. Check for the variable exported in your shell (`echo $ADO_PROJECT`); shell values override the Setup page by design. |
| **Setup** page says *Could not load the configuration* | `npm run web` is not running, or the browser cannot reach 127.0.0.1:3847. Open the page in Chrome or Edge. |
| OpenRouter returns 401 / 403 | Wrong `OPENROUTER_API_KEY`, or the model you configured needs paid credits. See [OPENROUTER.md](OPENROUTER.md). |
| Jira returns 401 | Wrong `JIRA_API_TOKEN` or `JIRA_EMAIL`. Re-create the token. |
| Import says no CSV is attached | Approval happens in the review panel: mark rows **Approve**, then **Submit to Jira**. The import step reads the newest CSV attached by Submit (on the **Test design** sub-task for Azure DevOps, on the typed issue otherwise) — an `APPROVED:` comment is not read any more. |
| Import ran but created nothing | The provider must be marked **In use** on Setup (nothing is In use by default), and its required fields must be filled. |
| No comment posted in Jira (Azure DevOps) | With Azure DevOps In use, the Jira key must point to a story that has a **Test design** QA sub-task, or directly to that sub-task. |

## Project layout (for the curious)

- `agent-docs.js` — runs one Jira issue end-to-end.
- `agent-update-csv.js` — updates an existing CSV when requirements change.
- `ado-*.js`, `testrail-*.js`, `zephyr-*.js`, `xray-*.js` — one client and one CSV importer per test management system (Azure DevOps also has test plan tools and the tag export).
- `tms-context.js` / `tms-export-csv.js` — provider-neutral: reading existing test cases as context, and exporting them back to CSV (Zephyr, Xray).
- `prompts-docs.js` — the LLM prompts the agent sends.
- `figma-client.js` / `prototype-client.js` — design context: the Figma file, and the deployed
  prototype crawled in a headless browser.
- `config-store.js` — the settings schema plus the local store behind the Setup page; also resolves the
  environment for every script (shell variables, then `config.local.json`).
- `web/` + `web-ui-server.js` — the local Web UI (`npm run web`), including `web/setup.html` and `web/issue-case.html`.
- `mcp-server.js` — MCP integration for Cursor.
- `scripts/launch-ai-test-coverage.{sh,ps1}` — the launcher: starts the server if needed and opens the Web UI (macOS `.sh`, Windows `.ps1`).
- `scripts/desktop-shortcut.js` + `scripts/{create,ensure}-desktop-shortcut.{ps1,sh}` — Desktop shortcut builders.
- `assets/` — icons used by the Desktop shortcut.

## Shell conventions used in these docs

- **Bash** snippets work on macOS, Linux, and Git Bash for Windows.
- **PowerShell** snippets are for Windows native shell.
- Variable assignments differ between the two; the docs show both side by side whenever it matters.
