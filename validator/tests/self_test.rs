//! The validator must accept a minimal good Construct and reject every known bad shape.

use cz_validator::check;

fn module(text: &str) -> Vec<u8> {
    wat::parse_str(text).expect("test module parses")
}

const GOOD: &str = r#"(module
  (import "cz_v1" "cz_v1_draw_joules" (func $draw (param i64) (result i64)))
  (memory (export "memory") 1 1)
  (func (export "cz_tick") (drop (call $draw (i64.const 1000)))))"#;

#[test]
fn accepts_a_minimal_construct() {
    assert_eq!(check(&module(GOOD), 1), Ok(()));
}

fn rejects(text: &str, needle: &str) {
    let issues = check(&module(text), 2).expect_err("module must be rejected");
    assert!(
        issues.iter().any(|issue| issue.contains(needle)),
        "expected an issue containing {needle:?}, got {issues:?}"
    );
}

#[test]
fn rejects_floats() {
    rejects(
        r#"(module (func (export "cz_tick") (drop (f64.const 1.5))))"#,
        "feature set",
    );
}

#[test]
fn rejects_simd() {
    rejects(
        r#"(module (func (export "cz_tick") (drop (v128.const i64x2 0 0))))"#,
        "feature set",
    );
}

#[test]
fn rejects_atomics() {
    rejects(
        r#"(module (memory 1 1 shared) (func (export "cz_tick") (drop (i32.atomic.load (i32.const 0)))))"#,
        "feature set",
    );
}

#[test]
fn rejects_foreign_imports() {
    rejects(
        r#"(module (import "env" "fetch" (func)) (func (export "cz_tick")))"#,
        "is not cz_v1",
    );
}

#[test]
fn rejects_unknown_host_calls() {
    rejects(
        r#"(module (import "cz_v1" "cz_v1_mint_joules" (func (param i64))) (func (export "cz_tick")))"#,
        "not a v1 host call",
    );
}

#[test]
fn rejects_wrong_signatures() {
    rejects(
        r#"(module (import "cz_v1" "cz_v1_sense" (func (param i64) (result i64))) (func (export "cz_tick")))"#,
        "wrong signature",
    );
}

#[test]
fn rejects_memory_over_the_cap() {
    rejects(
        r#"(module (memory 1 3) (func (export "cz_tick")))"#,
        "memory maximum",
    );
    rejects(
        r#"(module (memory 1) (func (export "cz_tick")))"#,
        "declare a maximum",
    );
}

#[test]
fn rejects_memory_over_the_manifest_limit() {
    let issues = check(
        &module(r#"(module (memory 1 2) (func (export "cz_tick")))"#),
        1,
    )
    .expect_err("manifest says one page");
    assert!(issues.iter().any(|issue| issue.contains("limit is 1")));
}

#[test]
fn requires_cz_tick() {
    rejects(
        r#"(module (func (export "run")))"#,
        "missing export cz_tick",
    );
}

#[test]
fn rejects_start_functions() {
    rejects(
        r#"(module (func $s) (start $s) (func (export "cz_tick")))"#,
        "start functions",
    );
}
