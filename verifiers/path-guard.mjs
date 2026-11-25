// A Construct pull request may touch only its own folder under constructs/submitted/ plus the
// construct workspace's Cargo.toml and Cargo.lock. Infrastructure changes go in separate PRs.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHARED = new Set(["constructs/Cargo.toml", "constructs/Cargo.lock"]);
const SUBMITTED = /^constructs\/submitted\/([a-z][a-z0-9-]{2,47})\//;

/** Returns the problems with a changed-file list, or an empty list when it is allowed. */
export function guard(files) {
  const folders = new Set(files.map((f) => SUBMITTED.exec(f)?.[1]).filter(Boolean));
  if (folders.size === 0) return [];
  const problems = [];
  if (folders.size > 1)
    problems.push(`one Construct per pull request; found ${[...folders].join(", ")}`);
  for (const file of files) {
    if (!SUBMITTED.test(file) && !SHARED.has(file)) {
      problems.push(`${file}: a Construct pull request may not change files outside its folder`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    console.log("path guard: not a pull request, skipped");
    process.exit(0);
  }
  const files = execFileSync("git", ["diff", "--name-only", `origin/${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const problems = guard(files);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`path guard: ${files.length} changed files allowed`);
}
