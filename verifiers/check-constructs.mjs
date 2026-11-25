// Validates every Construct in the workspace: manifest (public sdk rules), folder layout, and the
// compiled module (cz-validate). Run after `cargo build --release` in constructs/.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { validateConstructManifest } from "cradlezero";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const workspace = read("constructs/Cargo.toml");
const members = [
  ...(workspace.match(/members\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
]
  .map((m) => m[1])
  .filter((member) => member !== "abi");

const submitted = readdirSync(new URL("constructs/submitted/", root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `submitted/${entry.name}`);

const problems = [];
for (const folder of submitted) {
  if (!members.includes(folder))
    problems.push(`constructs/${folder}: add it to constructs/Cargo.toml members`);
}

let checked = 0;
for (const member of members) {
  const dir = `constructs/${member}`;
  const result = validateConstructManifest(JSON.parse(read(`${dir}/manifest.json`)));
  if (!result.ok) {
    for (const issue of result.issues) problems.push(`${dir}/manifest.json: ${issue}`);
    continue;
  }
  if (member.startsWith("submitted/") && member !== `submitted/${result.manifest.slug}`) {
    problems.push(`${dir}: folder name must equal the manifest slug ${result.manifest.slug}`);
  }
  const crate = read(`${dir}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const wasm = new URL(`constructs/target/wasm32-unknown-unknown/release/${crate}.wasm`, root);
  if (!existsSync(wasm)) {
    problems.push(`${dir}: ${crate}.wasm was not built`);
    continue;
  }
  try {
    execFileSync(
      "target/release/cz-validate",
      [wasm.pathname, String(result.manifest.memory_page_limit)],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    checked += 1;
  } catch {
    problems.push(`${dir}: module fails Construct ABI v1`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`constructs: ${checked} pass manifest and module checks`);
