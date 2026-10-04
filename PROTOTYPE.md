# Reading a live prototype

Design context for a generation run can come from two different places:

| Source | What it is | Where you paste it |
|---|---|---|
| **Figma** | The design *file* — frames, layers, component variants. | **Design link** on Create / Update |
| **Prototype** | The *running build* — a deployed clickable app (Netlify, Vercel, a Lovable preview, a staging URL). | **Prototype link** on Create / Update |

They are not alternatives. A ticket can carry both, and when they disagree the prototype wins for
"what the UI does today" — the prompt says so explicitly, and asks the model to call the difference
out in its reasoning.

This page is about the second one.

## Turning it on

1. Open **Setup** → **Azure DevOps** card → **Read prototype**. (The switch sits on that card, but it works whichever test management system is In use.)
2. Set it to **yes**. The default is **no**, and while it is *no* nothing changes anywhere:
   no extra field, no crawl, no extra cost.
3. Save.

**Create new test design** and **Update test design** now show a **Prototype link** field under the
Design link. Leave it empty on runs where you do not need it — the crawl only happens when there is
a link in the box.

## What happens when you run with a link

Before a single test case is generated, the agent:

1. **Fetches the app's own JavaScript** and scans it for route literals. This is the step that makes
   the difference for a single-page app: a prototype's home screen typically links to exactly *one*
   other screen, while its router knows about thirty. Those thirty are what you want covered.
2. **Starts a headless browser** (see *Requirements* below) and opens every candidate route, waiting
   for the network to go quiet so the screen is actually rendered rather than a blank `<div>`.
3. **Probes a nonsense URL once** to learn what this app's "not found" screen looks like, so mined
   routes that are not real screens get dropped instead of being described to the model as if they
   were.
4. **Reads each screen**: headings, visible copy, buttons and their disabled/active state, every form
   field with its label, placeholder, `required`, `maxlength`, `min`/`max`, `pattern` and option
   list, tabs, tables with their columns and row counts, open dialogs, status / error / empty-state
   text, image alt text, and the links out of the screen.
5. **Screenshots the first few screens** full-page and sends them to a vision model, which describes
   each screen and the end-to-end journeys they form.
6. **Follows every link** it found along the way, so screens reachable only by navigation are picked
   up too.

All of it becomes one `LIVE PROTOTYPE CONTEXT` block in the generation prompt, next to the Figma
block. The prompt instructs the model to treat those labels as the exact wording for steps and
expected results, to design at least one scenario per screen, to cover the transitions as flows, and
to invent nothing that is not in the inventory.

The run log shows the crawl as it happens:

```
🧭 Prototype: crawling https://your-prototype.netlify.app/ (up to 30 screen(s))
🧭 Prototype: mined 30 candidate route(s) from the app bundle.
🧭 Prototype: headless browser ready (Google Chrome)
   1. / — Welcome
   2. /m — Member experience
   …
🧭 Prototype analyzed: 25 screen(s) crawled, vision: 6 screen(s) via google/gemini-2.5-flash.
```

The same numbers land in `report.yaml` under `relatedDocumentation.prototype`, and a one-line summary
is included in the context comment posted to Jira.

**Regenerate does not re-crawl.** The crawl result is stored in the review session, so re-rolling one
test case, one checklist item or the whole set reuses it — you pay for the crawl once per run.

## Requirements

- **A Chromium-family browser on the machine running the agent.** Google Chrome, Chromium, Microsoft
  Edge or Brave — whichever is installed is found automatically. Nothing is downloaded and no npm
  package is added; the agent talks to the browser over the DevTools protocol.
- **A public (or at least locally reachable) URL.** The crawler does not log in. A prototype behind a
  password, an SSO wall or a VPN you are not on will come back as a single login screen.
- **`OPENROUTER_API_KEY`** for the screenshot pass. Without it the crawl still runs and you still get
  the full DOM inventory — only the visual description is skipped.

## Cost and time

About a minute for a 25-screen prototype, plus one vision call. The DOM inventory is text and cheap;
the screenshots are the expensive part, which is why only the first few screens are sent by default.

## Tuning

These are environment variables (set in your shell before starting the server) rather than fields on
the Setup page, because the defaults are right for almost every prototype:

| Variable | Default | What it does |
|---|---|---|
| `PROTOTYPE_MAX_PAGES` | `30` | How many distinct screens to crawl. Raise it for a big app; the log says when the budget was reached. |
| `PROTOTYPE_INCLUDE_VISION` | `true` | `false` skips the screenshot pass entirely (cheaper, text only). |
| `PROTOTYPE_VISION_MAX_PAGES` | `6` | How many screens are screenshotted and sent to the vision model. |
| `PROTOTYPE_VISION_MODEL` | `google/gemini-2.5-flash` | Falls back to `FIGMA_VISION_MODEL` if that is set. |
| `PROTOTYPE_VIEWPORT` | `1440x900` | Browser window size. Use something like `390x844` to crawl a mobile-first prototype at phone width. |
| `PROTOTYPE_NAV_TIMEOUT_MS` | `25000` | How long one screen may take to settle before it is skipped. |
| `PROTOTYPE_BROWSER_PATH` | *(auto-detected)* | Point at a browser executable when auto-detection fails. |

`PROTOTYPE_URL` itself is set by the Web UI from the Prototype link field. From the CLI, set it
yourself:

```bash
PROTOTYPE_URL='https://your-prototype.netlify.app/' JIRA_ISSUE_KEY='PROJ-1234' CHECK_APPROVAL=false node agent-docs.js
```

## Checking a prototype on its own

Before wiring a link into a real run, you can see exactly what the agent would read:

```bash
node prototype-client.js https://your-prototype.netlify.app/
```

It prints the whole context block and the crawl stats. The vision pass is off in this mode unless you
set `PROTOTYPE_INCLUDE_VISION=true`.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `No Chrome / Edge / Chromium found to render the prototype` | Install Google Chrome, or set `PROTOTYPE_BROWSER_PATH`. |
| `rendered no readable screen` | The URL is unreachable from this machine, or the whole app is behind a login. |
| Only one or two screens crawled | The app's routes are not string literals in the bundle (some routers build paths at runtime) *and* nothing links to the other screens. Paste a deeper URL, or run once per area. |
| "The page budget was reached" in the summary | There are more screens than `PROTOTYPE_MAX_PAGES`. Raise it. |
| Screens look half-rendered in the visual analysis | The prototype animates its entry slowly; raise `PROTOTYPE_NAV_TIMEOUT_MS`. |
| Everything renders at desktop width but the prototype is a phone design | Set `PROTOTYPE_VIEWPORT=390x844`. |
