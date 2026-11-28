import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { guard as pathGuard, readChangedFiles } from "./path-guard.mjs";
import {
  evaluatePullRequest,
  matchGlob,
  stripMarkdownNoise,
  validateConstructCargoTomlDiff,
  validatePolicy,
} from "./plan-guard.mjs";

const PLAN_GUARD_SCRIPT = fileURLToPath(new URL("./plan-guard.mjs", import.meta.url));

const BASE_POLICY = {
  schema_version: 1,
  repo: "world",
  tier0_max_files: 3,
  lockfiles: ["pnpm-lock.yaml", "Cargo.lock", "package.json", "Cargo.toml"],
  protected_globs: [
    "validator/**",
    "verifiers/**",
    "LICENSE.md",
    ".cz-protected-paths.json",
    ".gitleaks.toml",
    ".github/CODEOWNERS",
    ".github/workflows/**",
    "mise.toml",
    "package.json",
  ],
  owner_merge_always_globs: ["**"],
};

const BASE_CONSTRUCTS_CARGO = `# Construct workspace.
[workspace]
resolver = "3"
members = ["abi", "templates/construct-v1"]

[workspace.package]
edition = "2024"
rust-version = "1.100"
publish = false

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
debug = false
`;

const VALID_SUBMISSION_TERMS_BODY = `## What Changed
Add my-bot construct.

## How It Was Checked
- [x] \`gate\` passes locally

## Submission Terms
- [x] I agree that Section 3 (Submissions) of \`LICENSE.md\` governs this pull request, and I have the authority to agree to it.
- [X] AI-generated content and any third-party material in this pull request, with its license, are identified below.
`;

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CradleZero",
      GIT_AUTHOR_EMAIL: "dev@cradlezero.com",
      GIT_COMMITTER_NAME: "CradleZero",
      GIT_COMMITTER_EMAIL: "dev@cradlezero.com",
    },
  });
}

function writeRel(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function createWorldRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "cz-world-guard-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  runGit(repo, ["init", "-b", "main"]);
  writeRel(repo, ".cz-protected-paths.json", `${JSON.stringify(BASE_POLICY, null, 2)}\n`);
  writeRel(repo, "constructs/Cargo.toml", BASE_CONSTRUCTS_CARGO);
  writeRel(repo, "constructs/Cargo.lock", "# lock\n");
  writeRel(repo, "validator/src/lib.rs", "pub fn check() {}\n");
  writeRel(repo, "README.md", "# World\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  runGit(repo, ["checkout", "-b", "pr-branch"]);
  return repo;
}

function addValidConstructFiles(repo, slug = "my-bot") {
  writeRel(
    repo,
    `constructs/submitted/${slug}/manifest.json`,
    JSON.stringify({ abi_version: 1, slug }, null, 2),
  );
  writeRel(
    repo,
    `constructs/submitted/${slug}/Cargo.toml`,
    '[package]\nname = "my_bot"\nversion = "0.1.0"\n',
  );
  writeRel(repo, `constructs/submitted/${slug}/src/lib.rs`, "pub fn tick() {}\n");
}

function makeEvent({ title = "Add construct", body = "", draft = false, labels = [], headSha }) {
  return {
    pull_request: {
      title,
      body,
      draft,
      labels: labels.map((name) => ({ name })),
      base: { ref: "main" },
      head: { sha: headSha },
    },
  };
}

test("valid external Construct PR passes without EOS trailers", (t) => {
  const repo = createWorldRepo(t);
  addValidConstructFiles(repo, "my-bot");
  writeRel(
    repo,
    "constructs/Cargo.toml",
    BASE_CONSTRUCTS_CARGO.replace(
      'members = ["abi", "templates/construct-v1"]',
      'members = [\n  "abi",\n  "templates/construct-v1",\n  "submitted/my-bot",\n]',
    ),
  );
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Add my-bot construct"]);

  const headSha = runGit(repo, ["rev-parse", "HEAD"]).trim();
  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY, headSha }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, true, res.errors.join("\n"));
  assert.equal(res.mode, "construct-exemption");
  assert.equal(res.slug, "my-bot");
});

test("Construct PR checking only How It Was Checked boxes fails", (t) => {
  const repo = createWorldRepo(t);
  addValidConstructFiles(repo, "my-bot");
  writeRel(
    repo,
    "constructs/Cargo.toml",
    BASE_CONSTRUCTS_CARGO.replace(
      'members = ["abi", "templates/construct-v1"]',
      'members = ["abi", "templates/construct-v1", "submitted/my-bot"]',
    ),
  );
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Add my-bot"]);

  const spoofedBody = `## How It Was Checked
- [x] \`gate\` passes locally
- [x] No secrets, keys, or personal data in the diff

## Submission Terms
<!--
- [x] I agree that Section 3 (Submissions) of \`LICENSE.md\` governs this pull request, and I have the authority to agree to it.
- [x] AI-generated content and any third-party material in this pull request, with its license, are identified below.
-->
- [ ] I agree that Section 3 (Submissions) of \`LICENSE.md\` governs this pull request, and I have the authority to agree to it.
- [ ] AI-generated content and any third-party material in this pull request, with its license, are identified below.
`;

  const res = evaluatePullRequest({
    event: makeEvent({ body: spoofedBody }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("Section 3 (Submissions)")));
  assert.ok(res.errors.some((e) => e.includes("AI-generated and third-party")));
});

test("Construct PR adding a symlink (mode 120000) fails", (t) => {
  const repo = createWorldRepo(t);
  addValidConstructFiles(repo, "my-bot");
  symlinkSync("../../../LICENSE.md", join(repo, "constructs/submitted/my-bot/link.md"));
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Add symlink in construct"]);

  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("mode 120000")));
});

test("Construct PR editing [workspace.dependencies] in constructs/Cargo.toml fails", (t) => {
  const repo = createWorldRepo(t);
  addValidConstructFiles(repo, "my-bot");
  writeRel(
    repo,
    "constructs/Cargo.toml",
    `${BASE_CONSTRUCTS_CARGO.replace(
      'members = ["abi", "templates/construct-v1"]',
      'members = ["abi", "templates/construct-v1", "submitted/my-bot"]',
    )}\n[workspace.dependencies]\nevil = "0.1"\n`,
  );
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Add workspace.dependencies"]);

  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("workspace.members")));
});

test("Construct PR omitting manifest.json fails", (t) => {
  const repo = createWorldRepo(t);
  writeRel(
    repo,
    "constructs/submitted/my-bot/Cargo.toml",
    '[package]\nname = "my_bot"\nversion = "0.1.0"\n',
  );
  writeRel(repo, "constructs/submitted/my-bot/src/lib.rs", "pub fn tick() {}\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Missing manifest"]);

  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("manifest.json")));
});

test("Construct PR omitting Cargo.toml fails", (t) => {
  const repo = createWorldRepo(t);
  writeRel(
    repo,
    "constructs/submitted/my-bot/manifest.json",
    JSON.stringify({ abi_version: 1, slug: "my-bot" }),
  );
  writeRel(repo, "constructs/submitted/my-bot/src/lib.rs", "pub fn tick() {}\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Missing Cargo.toml"]);

  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("Cargo.toml")));
});

test("git mv validator/src/lib.rs into constructs/submitted/my-bot/ fails via --no-renames", (t) => {
  const repo = createWorldRepo(t);
  addValidConstructFiles(repo, "my-bot");
  runGit(repo, ["mv", "validator/src/lib.rs", "constructs/submitted/my-bot/lib.rs"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Rename validator file into construct"]);

  const changed = readChangedFiles({ baseRef: "main", githubRef: "", cwd: repo });
  assert.ok(changed.includes("validator/src/lib.rs"));
  assert.ok(changed.includes("constructs/submitted/my-bot/lib.rs"));
  assert.ok(pathGuard(changed).some((p) => p.includes("validator/src/lib.rs")));

  const res = evaluatePullRequest({
    event: makeEvent({ body: VALID_SUBMISSION_TERMS_BODY }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("validator/src/lib.rs")));
});

test("PR title containing $(id) or shell command executes zero shell commands", (t) => {
  const repo = createWorldRepo(t);
  const sentinel = join(repo, "shell-executed");
  writeRel(repo, "README.md", "# World updated\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Update README"]);

  const eventFile = join(repo, "event.json");
  const headSha = runGit(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    eventFile,
    JSON.stringify(
      makeEvent({
        title: `Update docs $(id) $(touch "${sentinel}") \`touch "${sentinel}"\``,
        body: "EOS-Tier: 0\nEOS-Linear: CZ-62\n",
        headSha,
      }),
    ),
  );

  execFileSync(
    process.execPath,
    [PLAN_GUARD_SCRIPT, "--event-path", eventFile, "--base", "main", "--cwd", repo],
    { encoding: "utf8" },
  );
  assert.equal(existsSync(sentinel), false);
});

test("maintainer EOS-Tier: 0 touching validator/** without p0-hotfix fails", (t) => {
  const repo = createWorldRepo(t);
  writeRel(repo, "validator/src/lib.rs", "pub fn check() { let _ = 1; }\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Edit validator"]);

  const res = evaluatePullRequest({
    event: makeEvent({ body: "EOS-Tier: 0\nEOS-Linear: CZ-62\n" }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("protected paths")));

  const hotfixRes = evaluatePullRequest({
    event: makeEvent({
      body: "EOS-Tier: 0\nEOS-Linear: CZ-62\nEOS-Override: p0-hotfix\n",
      labels: ["p0-hotfix"],
    }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(hotfixRes.ok, true, hotfixRes.errors.join("\n"));
});

test("PR self-tampering .cz-protected-paths.json fails against base commit policy", (t) => {
  const repo = createWorldRepo(t);
  const weakened = { ...BASE_POLICY, protected_globs: [] };
  writeRel(repo, ".cz-protected-paths.json", `${JSON.stringify(weakened, null, 2)}\n`);
  writeRel(repo, "validator/src/lib.rs", "pub fn check() { let _ = 2; }\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Attempt to weaken policy"]);

  const tier0Res = evaluatePullRequest({
    event: makeEvent({ body: "EOS-Tier: 0\nEOS-Linear: CZ-62\n" }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(tier0Res.ok, false);
  assert.ok(tier0Res.errors.some((e) => e.includes(".cz-protected-paths.json")));
  assert.ok(tier0Res.errors.some((e) => e.includes("validator/src/lib.rs")));

  const braced = { ...BASE_POLICY, protected_globs: ["{validator,verifiers}/**"] };
  writeRel(repo, ".cz-protected-paths.json", `${JSON.stringify(braced, null, 2)}\n`);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Inject brace glob"]);

  const tier2Res = evaluatePullRequest({
    event: makeEvent({
      body: "EOS-Tier: 2\nEOS-Linear: CZ-62\nEOS-Plan: engineering-operating-system\nEOS-Phase: 04c\n",
    }),
    cwd: repo,
    baseRef: "main",
    githubRef: "",
  });
  assert.equal(tier2Res.ok, false);
  assert.ok(tier2Res.errors.some((e) => e.includes("forbidden braces")));
});

test("merge ref diff (refs/pull/N/merge) uses HEAD^1 HEAD cleanly", (t) => {
  const repo = createWorldRepo(t);
  writeRel(repo, "README.md", "# PR edit\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "PR edit"]);
  const prHeadSha = runGit(repo, ["rev-parse", "HEAD"]).trim();

  // Advance main with an unrelated protected change, then create synthetic merge commit.
  runGit(repo, ["checkout", "main"]);
  writeRel(repo, "validator/src/lib.rs", "pub fn check() { /* main advance */ }\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Main advances"]);
  runGit(repo, ["checkout", "-b", "pr-merge"]);
  runGit(repo, ["merge", "--no-ff", "pr-branch", "-m", "Merge PR"]);

  const res = evaluatePullRequest({
    event: makeEvent({
      body: "EOS-Tier: 0\nEOS-Linear: CZ-62\n",
      headSha: prHeadSha,
    }),
    cwd: repo,
    baseRef: "main",
    githubRef: "refs/pull/42/merge",
  });
  assert.equal(res.ok, true, res.errors.join("\n"));
  assert.deepEqual(res.changedFiles, ["README.md"]);
});

test("utility checks: glob braces rejected, markdown stripping, Cargo.toml diff helper", () => {
  assert.throws(() => matchGlob("{a,b}/**", "a/c"), /braces/);
  assert.ok(validatePolicy({ ...BASE_POLICY, protected_globs: ["{a,b}"] }).length > 0);
  const stripped = stripMarkdownNoise("<!-- EOS-Tier: 0 -->\n```\nEOS-Tier: 1\n```\nEOS-Tier: 2\n");
  assert.equal(stripped.trim(), "EOS-Tier: 2");
  const badToml = validateConstructCargoTomlDiff(
    BASE_CONSTRUCTS_CARGO,
    BASE_CONSTRUCTS_CARGO.replace('opt-level = "z"', 'opt-level = "3"'),
    "my-bot",
  );
  assert.ok(badToml.length > 0);
});
