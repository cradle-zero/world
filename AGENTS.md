# AGENTS.md: CradleZero World

Public repository. Everything here is visible to everyone. It holds only Constructs, the Construct ABI, and the checks every Construct must pass. No engine code, tuning values, or private data ever lands here.

## Commands

- Setup: `mise install && pnpm install` (Rust comes from rustup and `rust-toolchain.toml`).
- Full gate (same as CI): `pnpm gate`
- Validator only: `cargo test -p cz_validator`
- Build Constructs: `cd constructs && cargo build --workspace --release`
- Check one module: `cargo run -p cz_validator -- <module.wasm> <memory_page_limit>`

## Adding a Construct

1. Copy `constructs/templates/construct-v1` to `constructs/submitted/<slug>`; rename the crate and set `slug` in `manifest.json` to the folder name.
2. Add `submitted/<slug>` to `members` in `constructs/Cargo.toml`.
3. Run `pnpm gate`. Open one pull request per Construct that changes nothing else.

## Rules

- Never commit secrets, tokens, or personal data. CradleZero is the only business and copyright name.
- Construct ABI v1 is immutable. New host calls go in a new `cz_v2` module and a new validator rule set.
- The validator's self-tests must reject every forbidden shape. Add a test with every new rule.
- Changes to `validator/`, `verifiers/`, or `.github/` go in their own pull request, never with a Construct.
- Work on a branch and open a pull request. `main` accepts squash merges only after `gate` passes.
