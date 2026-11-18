// Task definitions for the harness A/B. One JSON file per task so a diff to a
// task is a diff to one small file, and no YAML dependency is needed.
//
// Required: id, repo, prompt, timeoutMs.
// The check is optional and may use:
//   expectAnswerContains: string[]  - every string must appear in the final answer
//   command: string                 - bash -lc, run in `repo` after the run
//   expectContains: string[]        - every string must appear in the command output
//   expectExit: number              - the command's exit code must match
//
// A task that mutates its repo is a bad task: the run is not isolated. The
// runner refuses a dirty repo unless --allow-dirty, and tasks should be
// read-only so the next cell starts from the same state.

import fs from "node:fs";
import path from "node:path";

const REQUIRED = ["id", "repo", "prompt", "timeoutMs"];

/** Load every *.json task in a directory, validating the fields the runner uses. */
export function loadTasks(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  if (files.length === 0) throw new Error(`no task definitions in ${dir}`);

  const tasks = [];
  const seen = new Set();
  for (const file of files) {
    const full = path.join(dir, file);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      throw new Error(`${full}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const key of REQUIRED) {
      if (!(key in task)) throw new Error(`${full}: missing required field "${key}"`);
    }
    if (typeof task.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(task.id)) {
      throw new Error(`${full}: id must be a lowercase slug`);
    }
    if (seen.has(task.id)) throw new Error(`${full}: duplicate id "${task.id}"`);
    seen.add(task.id);
    if (!Number.isFinite(task.timeoutMs) || task.timeoutMs <= 0) {
      throw new Error(`${full}: timeoutMs must be a positive number`);
    }
    if (task.check && typeof task.check !== "object") {
      throw new Error(`${full}: check must be an object`);
    }
    tasks.push({ ...task, file: full });
  }
  return tasks;
}

/** Select tasks by comma-separated id, or all of them. */
export function selectTasks(tasks, spec) {
  if (!spec || spec === "all") return tasks;
  const wanted = String(spec)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(", ")}`);
  return wanted.map((id) => byId.get(id));
}

/** Replace {{name}} placeholders in a prompt. Unknown names are left alone. */
export function renderPrompt(prompt, vars) {
  return prompt.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}
