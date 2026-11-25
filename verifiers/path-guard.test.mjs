import assert from "node:assert/strict";
import { test } from "node:test";
import { guard } from "./path-guard.mjs";

test("infrastructure-only changes pass", () => {
  assert.deepEqual(guard(["validator/src/lib.rs", ".github/workflows/physics.yml"]), []);
});

test("a Construct with its workspace entry passes", () => {
  assert.deepEqual(
    guard([
      "constructs/submitted/thermal-harvester/src/lib.rs",
      "constructs/submitted/thermal-harvester/manifest.json",
      "constructs/Cargo.toml",
      "constructs/Cargo.lock",
    ]),
    [],
  );
});

test("a Construct that also edits the checks fails", () => {
  const problems = guard([
    "constructs/submitted/thermal-harvester/src/lib.rs",
    "validator/src/lib.rs",
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /validator\/src\/lib\.rs/);
});

test("two Constructs in one pull request fail", () => {
  const problems = guard([
    "constructs/submitted/thermal-harvester/src/lib.rs",
    "constructs/submitted/signal-beacon/src/lib.rs",
  ]);
  assert.match(problems[0], /one Construct per pull request/);
});
