/**
 * Pull the runner's own counts out of the answer. `check.passed` says the task
 * was completed; this says whether the suite it ran was actually green. They
 * are different questions and the baseline must not conflate them.
 */
export function suiteFromAnswer(answer) {
  // Markdown emphasis is common in a model answer: "**Passed:** 1132".
  const text = String(answer ?? "").replace(/[*_`]/g, "");
  const pass = /pass(?:ed)?\s*[:|]?\s*(\d+)/i.exec(text) ?? /(\d+)\s+(?:tests?\s+)?pass(?:ed)?/i.exec(text);
  const fail = /fail(?:ed)?\s*[:|]?\s*(\d+)/i.exec(text) ?? /(\d+)\s+(?:tests?\s+)?fail(?:ed)?/i.exec(text);
  if (!pass || !fail) return null;
  const passed = Number(pass[1]);
  const failed = Number(fail[1]);
  return { passed, failed, green: failed === 0 && passed > 0 };
}

