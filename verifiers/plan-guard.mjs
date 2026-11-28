// Enforces EOS pull request metadata, protected-path bounds, and hardened Construct isolation.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guard as pathGuard } from "./path-guard.mjs";

const EXPECTED_REPO = "world";
const MERGE_REF = /^refs\/pull\/\d+\/merge$/;
const SUBMITTED = /^constructs\/submitted\/([a-z][a-z0-9-]{2,47})\//;
const SHARED_CONSTRUCT_FILES = new Set(["constructs/Cargo.toml", "constructs/Cargo.lock"]);

const BLOCKED_LABELS = new Set(["hold", "do-not-merge", "wip"]);
const BLOCKED_TITLE_RE =
  /^(?:\[(?:HOLD|WIP|DO NOT MERGE)\]|(?:HOLD|WIP|DO NOT MERGE)\b)|\bDO NOT MERGE\b/i;

const KNOWN_TRAILERS = new Set([
  "EOS-Tier",
  "EOS-Linear",
  "EOS-Plan",
  "EOS-Phase",
  "EOS-Override",
  "EOS-Ratchet-ADR",
]);

const LINEAR_TOKEN_RE = /^CZ-[1-9][0-9]*$/;
const PLAN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIER1_PHASE_RE = /^(?:mini-rfc|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TIER2_PHASE_RE = /^[0-9]{2}[a-z]?$/;
const ADR_RE = /^ADR-[0-9]{4}$/;

const HARDCODED_PROTECTED_FLOOR = [
  ".github/workflows/**",
  ".github/CODEOWNERS",
  ".gitleaks.toml",
  ".cz-protected-paths.json",
  "mise.toml",
  "package.json",
];

const SUBMISSION_TERM_1_RE =
  /^\s*-\s*\[[xX]\]\s+I agree that Section 3 \(Submissions\) of `LICENSE\.md` governs this pull request, and I have the authority to agree to it\.\s*$/m;
const SUBMISSION_TERM_2_RE =
  /^\s*-\s*\[[xX]\]\s+AI-generated content and any third-party material in this pull request, with its license, are identified below\.\s*$/m;

const ALLOWED_POLICY_KEYS = new Set([
  "schema_version",
  "repo",
  "tier0_max_files",
  "lockfiles",
  "protected_globs",
  "owner_merge_always_globs",
]);

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function revParse(ref, cwd) {
  if (!ref) return null;
  try {
    return git(["rev-parse", "--verify", ref], cwd).trim();
  } catch {
    return null;
  }
}

function matchSegment(patternSeg, pathSeg) {
  let regex = "^";
  for (const ch of patternSeg) {
    if (ch === "*") {
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(pathSeg);
}

/** Deterministic flat POSIX glob matcher that rejects brace syntax. */
export function matchGlob(glob, filePath) {
  if (typeof glob !== "string" || glob.includes("{") || glob.includes("}")) {
    throw new Error(`Invalid glob pattern (braces are forbidden): ${String(glob)}`);
  }
  const patSegs = glob.split("/");
  const pathSegs = filePath.split("/");
  const memo = new Map();

  function dp(i, j) {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let result = false;
    if (i === patSegs.length && j === pathSegs.length) {
      result = true;
    } else if (i < patSegs.length && patSegs[i] === "**") {
      if (i === patSegs.length - 1 && i > 0) {
        result = j < pathSegs.length;
      } else {
        result = dp(i + 1, j) || (j < pathSegs.length && dp(i, j + 1));
      }
    } else if (i < patSegs.length && j < pathSegs.length) {
      result = matchSegment(patSegs[i], pathSegs[j]) && dp(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  }

  return dp(0, 0);
}

/** Validates a .cz-protected-paths.json object and rejects brace globs. */
export function validatePolicy(policy, expectedRepo = EXPECTED_REPO) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["policy must be a JSON object"];
  }
  for (const key of Object.keys(policy)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) {
      errors.push(`unknown policy key: ${key}`);
    }
  }
  if (policy.schema_version !== 1) {
    errors.push(`schema_version must be 1 (got ${String(policy.schema_version)})`);
  }
  if (policy.repo !== expectedRepo) {
    errors.push(`policy repo must be "${expectedRepo}" (got ${String(policy.repo)})`);
  }
  if (
    typeof policy.tier0_max_files !== "number" ||
    !Number.isInteger(policy.tier0_max_files) ||
    policy.tier0_max_files < 1
  ) {
    errors.push("tier0_max_files must be a positive integer");
  }
  for (const field of ["lockfiles", "protected_globs", "owner_merge_always_globs"]) {
    const list = policy[field];
    if (!Array.isArray(list)) {
      errors.push(`${field} must be an array`);
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== "string" || entry.length === 0) {
        errors.push(`${field} entries must be non-empty strings`);
        continue;
      }
      if (entry.includes("{") || entry.includes("}")) {
        errors.push(`${field} entry contains forbidden braces: ${entry}`);
      }
      if (entry.includes("\\") || entry.startsWith("/") || entry.split("/").includes("..")) {
        errors.push(`${field} entry must be a relative POSIX path or glob: ${entry}`);
      }
    }
  }
  return errors;
}

/** Strips HTML comments and fenced code blocks before parsing trailers or checkboxes. */
export function stripMarkdownNoise(body) {
  const withoutComments = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const lines = withoutComments.split(/\r?\n/);
  const kept = [];
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        continue;
      }
      kept.push(line);
    } else {
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }

  return kept.join("\n");
}

/** Extracts EOS-* trailers from stripped PR body text. */
export function parseTrailers(strippedBody) {
  const trailers = {};
  const errors = [];
  for (const line of strippedBody.split(/\r?\n/)) {
    const match = /^\s*(EOS-[A-Za-z0-9-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!KNOWN_TRAILERS.has(key)) {
      errors.push(`unknown trailer key: ${key}`);
      continue;
    }
    if (Object.hasOwn(trailers, key)) {
      errors.push(`duplicate trailer key: ${key}`);
      continue;
    }
    trailers[key] = value;
  }
  return { trailers, errors };
}

/** Parses git diff --no-renames --raw -z output into structured file entries. */
export function parseRawDiffZ(rawOutput) {
  const tokens = rawOutput.split("\0");
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i];
    if (!header) {
      i += 1;
      continue;
    }
    if (!header.startsWith(":")) {
      throw new Error(`unexpected raw diff header: ${header}`);
    }
    const parts = header.slice(1).split(" ");
    if (parts.length < 5) {
      throw new Error(`malformed raw diff header: ${header}`);
    }
    const [oldMode, newMode, oldSha, newSha, status] = parts;
    const path = tokens[i + 1];
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`missing path in raw diff for header: ${header}`);
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const destPath = tokens[i + 2];
      entries.push({ oldMode, newMode, oldSha, newSha, status, path, destPath });
      i += 3;
    } else {
      entries.push({ oldMode, newMode, oldSha, newSha, status, path });
      i += 2;
    }
  }
  return entries;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlStringArray(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("expected TOML array");
  }
  const inner = trimmed.slice(1, -1);
  const items = [];
  let i = 0;

  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    if (i >= inner.length) break;

    const ch = inner[i];
    if (ch !== '"' && ch !== "'") {
      throw new Error(`non-string array element near: ${inner.slice(i, i + 20)}`);
    }
    const quote = ch;
    i += 1;
    let value = "";
    let closed = false;
    while (i < inner.length) {
      const c = inner[i];
      if (quote === '"' && c === "\\") {
        i += 1;
        if (i >= inner.length) throw new Error("unterminated escape in TOML string");
        value += inner[i];
        i += 1;
        continue;
      }
      if (c === quote) {
        i += 1;
        closed = true;
        break;
      }
      value += c;
      i += 1;
    }
    if (!closed) throw new Error("unterminated string in TOML array");
    items.push(value);

    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    if (i < inner.length) {
      if (inner[i] !== ",") {
        throw new Error(`expected comma in TOML array near: ${inner.slice(i, i + 20)}`);
      }
      i += 1;
    }
  }
  return items;
}

function countUnquotedBrackets(text) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let sawCloseAtZero = false;
  let trailingAfterClose = "";

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (sawCloseAtZero) {
      trailingAfterClose += ch;
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) sawCloseAtZero = true;
      if (depth < 0) throw new Error("unbalanced ] in TOML array");
    }
  }
  if (quote !== null) throw new Error("unterminated string in TOML array");
  return { depth, sawCloseAtZero, trailingAfterClose };
}

/** Strictly parses constructs/Cargo.toml into table -> key -> value map. */
export function parseSimpleCargoToml(source) {
  const lines = source.split(/\r?\n/);
  const tables = new Map();
  let currentTable = "";
  tables.set(currentTable, new Map());

  for (let idx = 0; idx < lines.length; idx += 1) {
    const clean = stripTomlComment(lines[idx]).trim();
    if (clean.length === 0) continue;

    if (clean.startsWith("[[")) {
      throw new Error(`unsupported TOML array-of-tables syntax: ${clean}`);
    }
    if (clean.startsWith("[")) {
      const headerMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(clean);
      if (!headerMatch) {
        throw new Error(`unsupported TOML table header: ${clean}`);
      }
      currentTable = headerMatch[1];
      if (tables.has(currentTable)) {
        throw new Error(`duplicate TOML table: [${currentTable}]`);
      }
      tables.set(currentTable, new Map());
      continue;
    }

    const eqIdx = clean.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(`unsupported TOML statement: ${clean}`);
    }
    const key = clean.slice(0, eqIdx).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`unsupported TOML key: ${key}`);
    }
    const tableMap = tables.get(currentTable);
    if (tableMap.has(key)) {
      throw new Error(`duplicate TOML key "${key}" in [${currentTable}]`);
    }

    const rawVal = clean.slice(eqIdx + 1).trim();
    if (rawVal.startsWith('"""') || rawVal.startsWith("'''") || rawVal.startsWith("{")) {
      throw new Error(`unsupported TOML value syntax for key "${key}"`);
    }

    if (rawVal.startsWith("[")) {
      let combined = rawVal;
      let state = countUnquotedBrackets(combined);
      while (state.depth > 0) {
        idx += 1;
        if (idx >= lines.length) {
          throw new Error(`unterminated TOML array for key "${key}"`);
        }
        const nextClean = stripTomlComment(lines[idx]).trim();
        if (nextClean.length === 0) continue;
        combined += ` ${nextClean}`;
        state = countUnquotedBrackets(combined);
      }
      if (state.trailingAfterClose.trim().length > 0) {
        throw new Error(`unexpected trailing tokens after TOML array for key "${key}"`);
      }
      tableMap.set(key, { kind: "array", value: parseTomlStringArray(combined) });
    } else {
      tableMap.set(key, { kind: "scalar", value: rawVal });
    }
  }

  return tables;
}

/** Verifies constructs/Cargo.toml diff touches strictly workspace.members adding submitted/<slug>. */
export function validateConstructCargoTomlDiff(baseSource, headSource, slug) {
  let baseTables;
  let headTables;
  try {
    baseTables = parseSimpleCargoToml(baseSource);
  } catch (err) {
    return [`failed to parse base constructs/Cargo.toml: ${err.message}`];
  }
  try {
    headTables = parseSimpleCargoToml(headSource);
  } catch (err) {
    return [`constructs/Cargo.toml contains disallowed or invalid TOML syntax: ${err.message}`];
  }

  const baseNames = [...baseTables.keys()].sort();
  const headNames = [...headTables.keys()].sort();
  if (
    baseNames.length !== headNames.length ||
    baseNames.some((name, idx) => name !== headNames[idx])
  ) {
    return [
      "constructs/Cargo.toml edits in a Construct PR may only add workspace.members (tables changed)",
    ];
  }

  const problems = [];
  for (const tableName of baseNames) {
    const baseMap = baseTables.get(tableName);
    const headMap = headTables.get(tableName);
    const baseKeys = [...baseMap.keys()].sort();
    const headKeys = [...headMap.keys()].sort();
    if (baseKeys.length !== headKeys.length || baseKeys.some((key, idx) => key !== headKeys[idx])) {
      problems.push(
        `constructs/Cargo.toml table [${tableName}] keys changed; only workspace.members may be edited`,
      );
      continue;
    }
    for (const key of baseKeys) {
      const baseEntry = baseMap.get(key);
      const headEntry = headMap.get(key);
      if (tableName === "workspace" && key === "members") {
        if (baseEntry.kind !== "array" || headEntry.kind !== "array") {
          problems.push("constructs/Cargo.toml workspace.members must be a string array");
          continue;
        }
        const baseMembers = baseEntry.value;
        const headMembers = headEntry.value;
        const headSet = new Set(headMembers);
        if (headSet.size !== headMembers.length) {
          problems.push("constructs/Cargo.toml workspace.members contains duplicate entries");
        }
        for (const existing of baseMembers) {
          if (!headSet.has(existing)) {
            problems.push(
              `constructs/Cargo.toml workspace.members must not remove existing member "${existing}"`,
            );
          }
        }
        const baseSet = new Set(baseMembers);
        const added = headMembers.filter((m) => !baseSet.has(m));
        const expected = `submitted/${slug}`;
        if (added.length !== 1 || added[0] !== expected) {
          problems.push(
            `constructs/Cargo.toml workspace.members must add strictly "${expected}" (added: ${JSON.stringify(added)})`,
          );
        }
        continue;
      }

      if (
        baseEntry.kind !== headEntry.kind ||
        JSON.stringify(baseEntry.value) !== JSON.stringify(headEntry.value)
      ) {
        problems.push(
          `constructs/Cargo.toml key "${tableName ? `${tableName}.` : ""}${key}" changed; only workspace.members may be edited`,
        );
      }
    }
  }

  return problems;
}

function resolveDiffContext({ baseRef, githubRef, headSha, cwd }) {
  const isMergeRef =
    MERGE_REF.test(githubRef ?? "") &&
    typeof headSha === "string" &&
    headSha.length > 0 &&
    revParse("HEAD^1", cwd) !== null &&
    revParse("HEAD^2", cwd) === headSha;

  if (isMergeRef) {
    return {
      isMergeRef: true,
      baseCommit: "HEAD^1",
      diffRangeArgs: ["HEAD^1", "HEAD"],
    };
  }

  const resolvedBase =
    revParse(baseRef, cwd) !== null
      ? baseRef
      : baseRef && revParse(`origin/${baseRef}`, cwd) !== null
        ? `origin/${baseRef}`
        : null;

  if (!resolvedBase) {
    throw new Error(`unable to resolve base ref "${String(baseRef)}"`);
  }

  return {
    isMergeRef: false,
    baseCommit: resolvedBase,
    diffRangeArgs: [`${resolvedBase}...HEAD`],
  };
}

function loadPolicyFromBase(baseCommit, cwd) {
  let existsOnBase = false;
  try {
    git(["cat-file", "-e", `${baseCommit}:.cz-protected-paths.json`], cwd);
    existsOnBase = true;
  } catch {
    existsOnBase = false;
  }

  let raw;
  let source;
  if (existsOnBase) {
    raw = git(["show", `${baseCommit}:.cz-protected-paths.json`], cwd);
    source = `${baseCommit}:.cz-protected-paths.json`;
  } else {
    raw = readFileSync(join(cwd, ".cz-protected-paths.json"), "utf8");
    source = "working-tree bootstrap .cz-protected-paths.json";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${source}: ${err.message}`);
  }

  const policyErrors = validatePolicy(parsed, EXPECTED_REPO);
  if (policyErrors.length > 0) {
    throw new Error(`invalid ${source}: ${policyErrors.join("; ")}`);
  }

  return { policy: parsed, source, existsOnBase };
}

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function evaluateConstructExemption({ changedFiles, rawEntries, strippedBody, baseCommit, cwd }) {
  const problems = [];

  // Condition (a): path-guard clean, >= 1 file under constructs/submitted/<single-slug>/,
  // and zero files outside constructs/submitted/<single-slug>/** + constructs/Cargo.{toml,lock}.
  const pathProblems = pathGuard(changedFiles);
  problems.push(...pathProblems);

  const slugs = [...new Set(changedFiles.map((f) => SUBMITTED.exec(f)?.[1]).filter(Boolean))];
  if (slugs.length !== 1) {
    problems.push(
      `Construct exemption requires files under exactly one constructs/submitted/<slug>/ folder (found ${slugs.length})`,
    );
  }

  const slug = slugs.length === 1 ? slugs[0] : null;
  if (slug) {
    const prefix = `constructs/submitted/${slug}/`;
    for (const file of changedFiles) {
      if (!file.startsWith(prefix) && !SHARED_CONSTRUCT_FILES.has(file)) {
        problems.push(`${file}: outside constructs/submitted/${slug}/ and shared Cargo files`);
      }
    }
  }

  // Condition (b): zero added or modified symlinks (mode 120000).
  for (const entry of rawEntries) {
    if (entry.status !== "D" && entry.newMode === "120000") {
      problems.push(`${entry.path}: symlinks (mode 120000) are forbidden in Construct PRs`);
    }
  }

  // Condition (c): both manifest.json and Cargo.toml exist as regular files in PR tree.
  if (slug) {
    const manifestRel = `constructs/submitted/${slug}/manifest.json`;
    const cargoRel = `constructs/submitted/${slug}/Cargo.toml`;
    if (!isRegularFile(join(cwd, manifestRel))) {
      problems.push(`${manifestRel}: required file is missing or not a regular file`);
    }
    if (!isRegularFile(join(cwd, cargoRel))) {
      problems.push(`${cargoRel}: required file is missing or not a regular file`);
    }
  }

  // Condition (d): any edit to constructs/Cargo.toml touches strictly workspace.members adding "submitted/<slug>".
  if (slug && changedFiles.includes("constructs/Cargo.toml")) {
    let baseCargo;
    let headCargo;
    try {
      baseCargo = git(["show", `${baseCommit}:constructs/Cargo.toml`], cwd);
      headCargo = readFileSync(join(cwd, "constructs/Cargo.toml"), "utf8");
    } catch (err) {
      problems.push(`failed to read constructs/Cargo.toml for comparison: ${err.message}`);
    }
    if (baseCargo !== undefined && headCargo !== undefined) {
      problems.push(...validateConstructCargoTomlDiff(baseCargo, headCargo, slug));
    }
  }

  // Condition (e): verbatim - [x] / - [X] matches for BOTH Submission Terms sentences.
  if (!SUBMISSION_TERM_1_RE.test(strippedBody)) {
    problems.push(
      "Construct PR must check the verbatim Section 3 (Submissions) LICENSE.md checkbox under ## Submission Terms",
    );
  }
  if (!SUBMISSION_TERM_2_RE.test(strippedBody)) {
    problems.push(
      "Construct PR must check the verbatim AI-generated and third-party material checkbox under ## Submission Terms",
    );
  }

  return { ok: problems.length === 0, slug, problems };
}

function matchesAny(file, globs) {
  return globs.some((glob) => matchGlob(glob, file));
}

function validateMaintainerTrailers({ trailers, trailerErrors, labels, changedFiles, policy }) {
  const errors = [...trailerErrors];
  const effectiveProtected = [
    ...new Set([...policy.protected_globs, ...HARDCODED_PROTECTED_FLOOR]),
  ];

  const tierRaw = trailers["EOS-Tier"];
  if (tierRaw !== "0" && tierRaw !== "1" && tierRaw !== "2") {
    errors.push(`EOS-Tier must be 0, 1, or 2 (got ${JSON.stringify(tierRaw ?? "")})`);
  }

  const linearRaw = trailers["EOS-Linear"];
  if (!linearRaw) {
    errors.push("missing required EOS-Linear trailer");
  } else {
    const tokens = linearRaw.split(",").map((t) => t.trim());
    if (tokens.some((t) => !LINEAR_TOKEN_RE.test(t))) {
      errors.push(
        `EOS-Linear must be comma-separated CZ-<N> IDs (got ${JSON.stringify(linearRaw)})`,
      );
    }
  }

  if (Object.hasOwn(trailers, "EOS-Ratchet-ADR") && !ADR_RE.test(trailers["EOS-Ratchet-ADR"])) {
    errors.push(
      `EOS-Ratchet-ADR must match ADR-NNNN (got ${JSON.stringify(trailers["EOS-Ratchet-ADR"])})`,
    );
  }

  const override = trailers["EOS-Override"];
  if (override !== undefined && override !== "p0-hotfix") {
    errors.push(`EOS-Override must be "p0-hotfix" when set (got ${JSON.stringify(override)})`);
  }

  const protectedHits = changedFiles.filter((f) => matchesAny(f, effectiveProtected));
  const lockfileHits = changedFiles.filter((f) => matchesAny(f, policy.lockfiles));

  if (tierRaw === "0") {
    const plan = trailers["EOS-Plan"];
    const phase = trailers["EOS-Phase"];
    if (plan !== undefined && plan !== "" && plan !== "none") {
      errors.push('EOS-Tier: 0 must omit EOS-Plan or set it to "none"');
    }
    if (phase !== undefined && phase !== "" && phase !== "none") {
      errors.push('EOS-Tier: 0 must omit EOS-Phase or set it to "none"');
    }
    const hasP0Label = labels.has("p0-hotfix");
    if (override === "p0-hotfix" && !hasP0Label) {
      errors.push("EOS-Override: p0-hotfix requires the GitHub PR label p0-hotfix");
    }
    const isP0Hotfix = override === "p0-hotfix" && hasP0Label;
    if (!isP0Hotfix) {
      if (changedFiles.length > policy.tier0_max_files) {
        errors.push(
          `EOS-Tier: 0 allows at most ${policy.tier0_max_files} changed files (got ${changedFiles.length})`,
        );
      }
      if (lockfileHits.length > 0) {
        errors.push(
          `EOS-Tier: 0 cannot modify lockfiles without p0-hotfix: ${lockfileHits.join(", ")}`,
        );
      }
      if (protectedHits.length > 0) {
        errors.push(
          `EOS-Tier: 0 cannot modify protected paths without p0-hotfix: ${protectedHits.join(", ")}`,
        );
      }
    }
  } else if (tierRaw === "1") {
    if (override !== undefined) {
      errors.push("EOS-Override is forbidden on EOS-Tier: 1");
    }
    const plan = trailers["EOS-Plan"] ?? "";
    if (!PLAN_SLUG_RE.test(plan) || plan === "none") {
      errors.push(`EOS-Tier: 1 requires a valid EOS-Plan slug (got ${JSON.stringify(plan)})`);
    }
    const phase = trailers["EOS-Phase"];
    if (phase !== undefined && phase !== "" && !TIER1_PHASE_RE.test(phase)) {
      errors.push(
        `EOS-Tier: 1 EOS-Phase must be mini-rfc or a slug (got ${JSON.stringify(phase)})`,
      );
    }
    if (protectedHits.length > 0) {
      errors.push(`EOS-Tier: 1 cannot modify protected paths: ${protectedHits.join(", ")}`);
    }
  } else if (tierRaw === "2") {
    if (override !== undefined) {
      errors.push("EOS-Override is forbidden on EOS-Tier: 2");
    }
    const plan = trailers["EOS-Plan"] ?? "";
    if (!PLAN_SLUG_RE.test(plan) || plan === "none") {
      errors.push(`EOS-Tier: 2 requires a valid EOS-Plan slug (got ${JSON.stringify(plan)})`);
    }
    const phase = trailers["EOS-Phase"] ?? "";
    if (!TIER2_PHASE_RE.test(phase)) {
      errors.push(
        `EOS-Tier: 2 in world requires EOS-Phase matching ^[0-9]{2}[a-z]?$ (got ${JSON.stringify(phase)})`,
      );
    }
  }

  return errors;
}

/** Evaluates a pull request against EOS-C3, EOS-C4, and Construct isolation rules. */
export function evaluatePullRequest({
  event,
  cwd = process.cwd(),
  githubRef = process.env.GITHUB_REF ?? "",
  baseRef = event?.pull_request?.base?.ref ?? process.env.GITHUB_BASE_REF,
}) {
  const pr = event?.pull_request;
  if (!pr || typeof pr !== "object") {
    return { ok: false, errors: ["pull_request payload is missing from event JSON"] };
  }

  const errors = [];

  // Defense-in-depth Draft / Hold / WIP / DO NOT MERGE check.
  if (pr.draft === true) {
    errors.push("PR is marked as Draft");
  }
  const labels = new Set(
    (Array.isArray(pr.labels) ? pr.labels : [])
      .map((lbl) => (typeof lbl === "string" ? lbl : lbl?.name))
      .filter((name) => typeof name === "string")
      .map((name) => name.trim().toLowerCase()),
  );
  const hitBlockedLabels = [...labels].filter((lbl) => BLOCKED_LABELS.has(lbl)).sort();
  if (hitBlockedLabels.length > 0) {
    errors.push(`PR carries blocking label(s): ${hitBlockedLabels.join(", ")}`);
  }
  if (BLOCKED_TITLE_RE.test(String(pr.title ?? ""))) {
    errors.push("PR title carries HOLD/WIP/DO NOT MERGE marker");
  }

  let diffCtx;
  try {
    diffCtx = resolveDiffContext({
      baseRef,
      githubRef,
      headSha: pr.head?.sha,
      cwd,
    });
  } catch (err) {
    return { ok: false, errors: [...errors, err.message] };
  }

  let policy;
  try {
    ({ policy } = loadPolicyFromBase(diffCtx.baseCommit, cwd));
  } catch (err) {
    return { ok: false, errors: [...errors, err.message] };
  }

  const changedFiles = git(
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      ...diffCtx.diffRangeArgs,
    ],
    cwd,
  )
    .split("\0")
    .filter(Boolean);

  const rawOutput = git(
    ["-c", "core.quotepath=false", "diff", "--no-renames", "--raw", "-z", ...diffCtx.diffRangeArgs],
    cwd,
  );
  const rawEntries = parseRawDiffZ(rawOutput);

  // If the PR edits .cz-protected-paths.json itself, validate the PR's head policy too.
  if (changedFiles.includes(".cz-protected-paths.json")) {
    try {
      const headPolicyRaw = readFileSync(join(cwd, ".cz-protected-paths.json"), "utf8");
      const headPolicy = JSON.parse(headPolicyRaw);
      const headPolicyErrors = validatePolicy(headPolicy, EXPECTED_REPO);
      if (headPolicyErrors.length > 0) {
        errors.push(`invalid modified .cz-protected-paths.json: ${headPolicyErrors.join("; ")}`);
      }
    } catch (err) {
      errors.push(`failed to validate modified .cz-protected-paths.json: ${err.message}`);
    }
  }

  const strippedBody = stripMarkdownNoise(pr.body ?? "");
  const { trailers, errors: trailerErrors } = parseTrailers(strippedBody);
  const hasAnyTrailers = Object.keys(trailers).length > 0 || trailerErrors.length > 0;
  const touchesSubmittedConstruct = changedFiles.some((f) => SUBMITTED.test(f));

  if (!hasAnyTrailers && touchesSubmittedConstruct) {
    const constructResult = evaluateConstructExemption({
      changedFiles,
      rawEntries,
      strippedBody,
      baseCommit: diffCtx.baseCommit,
      cwd,
    });
    if (!constructResult.ok) {
      errors.push(...constructResult.problems);
    }
    return {
      ok: errors.length === 0,
      mode: "construct-exemption",
      slug: constructResult.slug,
      changedFiles,
      errors,
    };
  }

  errors.push(
    ...validateMaintainerTrailers({
      trailers,
      trailerErrors,
      labels,
      changedFiles,
      policy,
    }),
  );

  return {
    ok: errors.length === 0,
    mode: "maintainer",
    changedFiles,
    errors,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--event-path" && i + 1 < argv.length) {
      opts.eventPath = argv[++i];
    } else if (arg === "--base" && i + 1 < argv.length) {
      opts.baseRef = argv[++i];
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      opts.cwd = argv[++i];
    }
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cli = parseCliArgs(process.argv.slice(2));
  const eventPath = cli.eventPath ?? process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";

  if (!eventPath) {
    if (eventName === "pull_request" || process.env.GITHUB_BASE_REF) {
      console.error("plan guard: GITHUB_EVENT_PATH is required for pull_request events");
      process.exit(1);
    }
    console.log("plan guard: not a pull request, skipped");
    process.exit(0);
  }

  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (err) {
    console.error(`plan guard: failed to read event JSON: ${err.message}`);
    process.exit(1);
  }

  const result = evaluatePullRequest({
    event,
    cwd: cli.cwd ?? process.cwd(),
    baseRef: cli.baseRef ?? event?.pull_request?.base?.ref ?? process.env.GITHUB_BASE_REF,
    githubRef: process.env.GITHUB_REF ?? "",
  });

  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`plan guard: ${err}`);
    }
    process.exit(1);
  }

  console.log(`plan guard: ok (${result.mode}, ${result.changedFiles.length} changed file(s))`);
}
