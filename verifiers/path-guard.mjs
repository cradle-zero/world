// A Construct pull request may touch only its own folder under constructs/submitted/ plus the
// construct workspace's Cargo.toml and Cargo.lock. Infrastructure changes go in separate PRs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHARED = new Set(["constructs/Cargo.toml", "constructs/Cargo.lock"]);
const SUBMITTED = /^constructs\/submitted\/([a-z][a-z0-9-]{2,47})\//;
const MERGE_REF = /^refs\/pull\/\d+\/merge$/;

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

function readPullRequestHeadSha(eventPath) {
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const sha = event?.pull_request?.head?.sha;
    return typeof sha === "string" && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function revParse(ref, cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolves the changed files using --no-renames -z so git mv cannot hide deletions. */
export function readChangedFiles({
  baseRef = process.env.GITHUB_BASE_REF,
  githubRef = process.env.GITHUB_REF ?? "",
  eventPath = process.env.GITHUB_EVENT_PATH,
  headSha = readPullRequestHeadSha(eventPath),
  cwd = process.cwd(),
} = {}) {
  const isMergeRef =
    MERGE_REF.test(githubRef) &&
    headSha !== null &&
    revParse("HEAD^1", cwd) !== null &&
    revParse("HEAD^2", cwd) === headSha;
  const diffArgs = isMergeRef
    ? ["-c", "core.quotepath=false", "diff", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD"]
    : [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        `${revParse(baseRef, cwd) ? baseRef : `origin/${baseRef}`}...HEAD`,
      ];
  return execFileSync("git", diffArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    console.log("path guard: not a pull request, skipped");
    process.exit(0);
  }
  const files = readChangedFiles({ baseRef: base });
  const problems = guard(files);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`path guard: ${files.length} changed files allowed`);
}
