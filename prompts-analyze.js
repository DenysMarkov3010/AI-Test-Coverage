/**
 * Prompt for "Analyze requirements": read a ticket and everything attached to it, and produce what
 * a QA engineer brings to backlog refinement (grooming) — the questions to ask, the gaps, the places
 * where the sources disagree, and requirement-quality findings.
 *
 * The yardstick is ISO/IEC/IEEE 29148:2018 (requirements engineering): the characteristics of an
 * individual requirement and of a set of requirements, and its requirements-language criteria.
 * Nothing here is project specific; the sources come from prompt-context.js blocks.
 */

const pc = require("./prompt-context");

const ISO_29148_BLOCK = `
QUALITY YARDSTICK — ISO/IEC/IEEE 29148:2018
Characteristics of an individual requirement:
- Necessary — it states something the stakeholders actually need; removing it leaves a gap.
- Appropriate — it is at the right level of abstraction for the ticket (not a hidden design decision, not too vague).
- Unambiguous — it can be read only one way.
- Complete — it needs no further information to be understood, built and tested (actors, conditions, data, outcomes, limits).
- Singular — it states one requirement, not several joined by "and / or".
- Feasible — it can be achieved within the known constraints.
- Verifiable — its fulfilment can be shown by test, inspection, analysis or demonstration, with a clear pass / fail.
- Correct — it reflects the real need of the source it comes from.
- Conforming — it follows the team's agreed template / format (e.g. user story + acceptance criteria).
Characteristics of the set of requirements (the ticket as a whole):
- Complete — together they cover the whole need, including error, empty, permission and boundary situations.
- Consistent — no contradictions between them or with the design, prototype, documentation or related tickets.
- Feasible — the set can be delivered together.
- Comprehensible — a reader understands what is expected of the system and how it relates to its environment.
- Able to be validated — it can be shown that the set, once built, satisfies the stakeholder need.
Requirements-language criteria — words that usually hide a problem:
superlatives ("best", "most"); subjective language ("user-friendly", "easy", "intuitive", "fast"); vague pronouns ("it", "this", "they" with no clear referent); ambiguous adverbs and adjectives ("almost always", "significant", "minimal", "appropriate"); open-ended terms ("support", "but not limited to", "etc.", "and so on", "as a minimum"); comparatives with no baseline ("better", "faster than before"); loopholes ("if possible", "as applicable", "where appropriate", "TBD"); totality ("all", "always", "never", "every", "any") that is rarely meant literally; negative-only statements ("the system shall not …") with no positive behaviour.`;

const GROOMING_METHOD_BLOCK = `
HOW TO ANALYSE (in this order):
1. Understand: what THIS ticket asks for, for whom, and why. Analyse the requirements of this ticket only — the related tickets, Confluence pages and related test cases explain the area around it; they never add requirements to it, and their own open points are not questions for this ticket.
2. Extract the stated requirements (description, acceptance criteria, comment decisions, attachments, design, prototype) and check each against the individual characteristics and the language criteria.
3. Check the set for completeness. Walk the usual blind spots and keep only the ones this ticket really leaves open: actors and permissions; preconditions and entry points; input data, formats, limits and defaults; validation and error messages; empty, loading and error states; state changes and what is persisted; concurrency and repeated actions; notifications, audit and history; integrations and data that flows in or out; existing data and migration; non-functional expectations the ticket implies (performance, security, privacy, accessibility, localisation, time zones); acceptance criteria and how each would be verified; what is explicitly out of scope.
4. Compare the sources with each other: ticket ↔ comments ↔ attachments ↔ design ↔ prototype ↔ Confluence ↔ related tickets ↔ related test cases. Every real disagreement (a label, a value, a flow, a rule, a state, an element present in one source and missing in another) is a difference.
5. Turn every finding into a question someone can answer in the meeting.

RULES FOR THE QUESTIONS:
- Ask only what the sources do not already answer. If a comment already settled it, list it under "alreadyDecided" instead. A question asked in the comments and never answered is still open — ask it again and say so.
- Each question is concrete and answerable, refers to the exact text or element that triggered it, and where useful gives an example situation ("What happens if the user mutes a chat while offline?"), not a generic prompt ("What about edge cases?").
- One question per point; do not bundle.
- Say who can answer it best (Product owner, Business analyst, Designer, Developer, QA) and how urgent it is: "blocker" (development or test design cannot start without it), "high" (affects behaviour or acceptance), "medium" (detail that can be settled during the sprint).
- Propose the assumption you would make if nobody answers — it speeds the meeting up.
- No padding: quality over count. A small, clear ticket may legitimately produce only a few questions.`;

function buildRequirementsAnalysisPrompt(ctx) {
  const {
    relatedTickets = "",
    confluenceText = "",
    designText = "",
    prototypeText = "",
    attachmentsText = "",
    commentsText = "",
    existingTests = [],
  } = ctx;

  const sources = [
    commentsText && `\n\n<issue_comments>\n${commentsText}\n</issue_comments>`,
    attachmentsText && `\n\n<attachments>\n${attachmentsText}\n</attachments>`,
    designText && `\n\n<design>\n${designText}\n</design>`,
    prototypeText && `\n\n<prototype>\n${prototypeText}\n</prototype>`,
    confluenceText && `\n\n<confluence_pages>\n${confluenceText}\n</confluence_pages>`,
    relatedTickets && `\n\n<related_tickets>\n${relatedTickets}\n</related_tickets>\nThe related tickets were named by the QA engineer for this analysis: neighbouring work and context. They do not add requirements to this ticket, but a contradiction with them is a difference, and a dependency on them is worth a question.`,
    existingTests.length &&
      `\n\n<related_test_cases>\n${existingTests
        .map((f) => `--- ${f.filename}${f.trimmed ? " (most related cases only)" : ""}\n${String(f.content).trim()}`)
        .join("\n\n")}\n</related_test_cases>\nThese test cases already exist in the test management system for this area. They show current behaviour and vocabulary. Where the ticket changes what they assert, that is a difference (and possibly a question about migration of existing behaviour).`,
  ]
    .filter(Boolean)
    .join("");

  return `You are a senior QA engineer and business analyst preparing for backlog refinement (grooming). Analyse the ticket below together with everything attached to it, and prepare what you would raise in the meeting: questions, missing information, contradictions between the sources, and requirement-quality issues. You do NOT design tests here.

${pc.buildTicketSection(ctx)}

SOURCES (each in its own tag; the ticket is the requirement, the rest is supporting material):${sources || "\n\nNo supporting material was provided: analyse the ticket alone."}

${ISO_29148_BLOCK}

${GROOMING_METHOD_BLOCK}

OUTPUT — return ONLY valid JSON (no markdown fences, no prose before or after) with exactly this shape:
{
  "understanding": "string: 2–4 sentences — what the ticket asks for, for whom and why, as you understood it from all sources",
  "verdict": "ready" | "needs clarification" | "not ready",
  "verdictReason": "string: one or two sentences",
  "setAssessment": [
    { "characteristic": "Complete" | "Consistent" | "Feasible" | "Comprehensible" | "Able to be validated", "rating": "ok" | "partial" | "problem", "note": "string" }
  ],
  "questions": [
    {
      "id": "Q1",
      "question": "string",
      "category": "Scope" | "Business rules" | "UI / UX" | "Data" | "Permissions" | "Errors and edge cases" | "States and flows" | "Integrations" | "Non-functional" | "Acceptance criteria" | "Dependencies",
      "priority": "blocker" | "high" | "medium",
      "askWho": "Product owner" | "Business analyst" | "Designer" | "Developer" | "QA",
      "why": "string: why it matters — what goes wrong or stays untestable without an answer",
      "trigger": "string: the exact text / element / source that raised it (quote briefly), or 'not mentioned anywhere'",
      "isoCharacteristic": "string: the ISO/IEC/IEEE 29148 characteristic at stake, e.g. 'Complete', 'Unambiguous', 'Verifiable', 'Consistent'",
      "assumptionIfUnanswered": "string",
      "stillOpenFromComments": false
    }
  ],
  "differences": [
    {
      "topic": "string: what the sources disagree about",
      "statements": [ { "source": "ticket | comments | attachment [A#] | design | prototype | confluence | related ticket KEY | related test case", "says": "string" } ],
      "impact": "string: what goes wrong if it is not resolved",
      "question": "string: the question that resolves it"
    }
  ],
  "qualityIssues": [
    {
      "text": "string: the requirement text as written (short quote)",
      "source": "string",
      "characteristics": ["Unambiguous", "Verifiable"],
      "problem": "string",
      "suggestedRewrite": "string: a verifiable rewrite, using only facts from the sources (mark any guessed value as an assumption)"
    }
  ],
  "gaps": [
    { "area": "string: e.g. 'Permissions', 'Error handling', 'Empty state', 'Data retention'", "missing": "string", "whyItMatters": "string" }
  ],
  "alreadyDecided": ["string: decisions already made in the comments or sources that the team should not reopen"],
  "assumptions": ["string: assumptions the analysis itself had to make"],
  "contextNotes": ["string: how the related tickets, Confluence pages and related test cases relate to this ticket (one line each)"]
}

RULES:
- ${pc.languageRule()}
- Questions are ordered: blockers first, then high, then medium; inside a priority, by the order they would come up in the meeting.
- A difference needs at least two sources that really disagree; an element shown in the design or prototype but absent from the ticket (or the other way round) counts.
- Do not invent facts. Values that are not in any source appear only as questions or as assumptions.
- Never copy values shown as "(… removed)" and never invent real-looking personal data.`;
}

module.exports = { buildRequirementsAnalysisPrompt, ISO_29148_BLOCK, GROOMING_METHOD_BLOCK };
