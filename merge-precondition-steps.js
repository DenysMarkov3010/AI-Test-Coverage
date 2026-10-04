/**
 * Azure DevOps TCM often stores one logical "Preconditions" block as multiple <step> rows.
 * Merge them into a single step (step 1) so CSV / flows match the agent CSV format (one Preconditions row).
 */

function isTrivialExpected(expected) {
  const t = String(expected ?? "").trim();
  return !t || t === "—" || t === "-" || t === "–" || t === "--";
}

/** Heuristic: first real UI action after preconditions (English-style test steps). */
function isRealUiStep(action) {
  const t = String(action ?? "").trim();
  if (!t) return false;
  return (
    /^(Log\s*in|Login)\b/i.test(t) ||
    /^Navigate to\b/i.test(t) ||
    /^Click\b/i.test(t) ||
    /^Double-click\b/i.test(t) ||
    /^Right-click\b/i.test(t) ||
    /^Open\b/i.test(t) ||
    /^Tap\b/i.test(t) ||
    /^Return to\b/i.test(t) ||
    /^Go to\b/i.test(t) ||
    /^Switch to\b/i.test(t) ||
    /^Select the\b/i.test(t) ||
    /^Enter\b/i.test(t) ||
    /^Type\b/i.test(t) ||
    /^Fill\b/i.test(t) ||
    /^Verify\b/i.test(t) ||
    /^Check that\b/i.test(t) ||
    /^Search\b/i.test(t) ||
    /^Submit\b/i.test(t) ||
    /^Close\b/i.test(t) ||
    /^Wait\b/i.test(t) ||
    /^Refresh\b/i.test(t) ||
    /^Reload\b/i.test(t) ||
    /^Move the\b/i.test(t) ||
    /^Change the\b/i.test(t) ||
    /^Complete\b/i.test(t) ||
    /^Show\b/i.test(t) ||
    /^Hide\b/i.test(t) ||
    /^Press\b/i.test(t) ||
    /^Swipe\b/i.test(t) ||
    /^Install\b/i.test(t) ||
    /^Launch\b/i.test(t) ||
    /^Download\b/i.test(t) ||
    /^Upload\b/i.test(t) ||
    /^Add\b/i.test(t) ||
    /^Remove\b/i.test(t) ||
    /^Clear\b/i.test(t) ||
    /^Scroll\b/i.test(t) ||
    /^Drag\b/i.test(t) ||
    /^Drop\b/i.test(t)
  );
}

function firstActionStartsWithPreconditions(action) {
  const t = String(action ?? "").trim();
  return /^\s*Preconditions?\s*:?/i.test(t) || /^\s*Precondition\s*:?/i.test(t);
}

/**
 * @param {{ action: string, expected: string }[]} steps
 * @returns {{ action: string, expected: string }[]}
 */
function mergePreconditionStepsPlain(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return steps;
  if (!firstActionStartsWithPreconditions(steps[0].action)) return steps;

  const parts = [steps[0].action];
  const firstExpected = steps[0].expected;
  let i = 1;
  while (i < steps.length) {
    if (isRealUiStep(steps[i].action)) break;
    parts.push(steps[i].action);
    i++;
  }
  if (i < 2) return steps;

  const rest = steps.slice(i);
  return [{ action: parts.filter(Boolean).join("\n"), expected: firstExpected ?? "" }, ...rest];
}

/**
 * @param {{ stepNumber: number, action: string, expected: string }[]} steps
 * @returns {{ stepNumber: number, action: string, expected: string }[]}
 */
function mergePreconditionStepsForTestCase(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return steps;
  const sorted = [...steps].sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
  const plain = sorted.map((s) => ({ action: s.action, expected: s.expected }));
  const merged = mergePreconditionStepsPlain(plain);
  return merged.map((s, idx) => ({
    stepNumber: idx + 1,
    action: s.action,
    expected: s.expected,
  }));
}

module.exports = {
  mergePreconditionStepsPlain,
  mergePreconditionStepsForTestCase,
  isRealUiStep,
  isTrivialExpected,
};
