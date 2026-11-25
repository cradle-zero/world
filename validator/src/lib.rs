//! Construct ABI v1 static checks. A module passes only if every rule holds.

use wasmparser::{ExternalKind, Parser, Payload, TypeRef, ValType, Validator, WasmFeatures};

/// Import module every v1 host call comes from.
pub const ABI_V1_MODULE: &str = "cz_v1";
/// Linear memory ceiling, in 64 KiB pages.
pub const MEMORY_PAGE_LIMIT: u64 = 2;
/// Largest module accepted, in bytes.
pub const MODULE_BYTE_LIMIT: usize = 65_536;

/// Host calls a v1 Construct may import: (name, params, result).
const IMPORTS: &[(&str, &[ValType], &[ValType])] = &[
    ("cz_v1_sense", &[ValType::I32], &[ValType::I64]),
    ("cz_v1_draw_joules", &[ValType::I64], &[ValType::I64]),
    ("cz_v1_emit_wave", &[ValType::I64], &[ValType::I32]),
];

/// Integer-only WebAssembly 2.0: no floats, no SIMD, no threads or atomics.
#[must_use]
pub fn allowed_features() -> WasmFeatures {
    WasmFeatures::WASM2
        .difference(WasmFeatures::FLOATS)
        .difference(WasmFeatures::SIMD)
        .difference(WasmFeatures::SATURATING_FLOAT_TO_INT)
}

/// Checks a module. `manifest_page_limit` is the manifest's `memory_page_limit`.
///
/// # Errors
/// Returns every rule the module breaks.
pub fn check(bytes: &[u8], manifest_page_limit: u64) -> Result<(), Vec<String>> {
    let mut issues = Vec::new();
    if bytes.len() > MODULE_BYTE_LIMIT {
        issues.push(format!(
            "module is {} bytes; limit is {MODULE_BYTE_LIMIT}",
            bytes.len()
        ));
    }
    if let Err(error) = Validator::new_with_features(allowed_features()).validate_all(bytes) {
        issues.push(format!("invalid under the v1 feature set: {error}"));
        return Err(issues);
    }

    let mut func_types: Vec<(Vec<ValType>, Vec<ValType>)> = Vec::new();
    let mut imported_funcs: Vec<u32> = Vec::new();
    let mut local_funcs: Vec<u32> = Vec::new();
    let mut tick_export: Option<u32> = None;
    let page_ceiling = manifest_page_limit.min(MEMORY_PAGE_LIMIT);

    for payload in Parser::new(0).parse_all(bytes) {
        let Ok(payload) = payload else {
            issues.push("module could not be parsed".into());
            break;
        };
        match payload {
            Payload::TypeSection(reader) => {
                for ty in reader.into_iter_err_on_gc_types() {
                    match ty {
                        Ok(f) => func_types.push((f.params().to_vec(), f.results().to_vec())),
                        Err(_) => issues.push("type section uses non-function types".into()),
                    }
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let Ok(import) = import else { continue };
                    let TypeRef::Func(index) = import.ty else {
                        issues.push(format!(
                            "import {}.{} must be a function",
                            import.module, import.name
                        ));
                        continue;
                    };
                    imported_funcs.push(index);
                    if import.module != ABI_V1_MODULE {
                        issues.push(format!(
                            "import module {} is not {ABI_V1_MODULE}",
                            import.module
                        ));
                        continue;
                    }
                    let Some((_, params, results)) =
                        IMPORTS.iter().find(|(n, _, _)| *n == import.name)
                    else {
                        issues.push(format!("{} is not a v1 host call", import.name));
                        continue;
                    };
                    let actual = func_types.get(index as usize);
                    if actual.is_none_or(|(p, r)| p != params || r != results) {
                        issues.push(format!("{} has the wrong signature", import.name));
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                local_funcs.extend(reader.into_iter().flatten());
            }
            Payload::MemorySection(reader) => {
                for memory in reader.into_iter().flatten() {
                    match memory.maximum {
                        Some(max) if max <= page_ceiling && memory.initial <= max => {}
                        Some(max) => issues.push(format!(
                            "memory maximum is {max} pages; limit is {page_ceiling}"
                        )),
                        None => issues.push("memory must declare a maximum".into()),
                    }
                    if memory.shared || memory.memory64 {
                        issues.push("memory must be unshared 32-bit".into());
                    }
                }
            }
            Payload::TableSection(reader) => {
                for table in reader.into_iter().flatten() {
                    if table.ty.maximum.is_none_or(|max| max > 64) {
                        issues.push("tables must declare a maximum of at most 64".into());
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader.into_iter().flatten() {
                    match export.kind {
                        ExternalKind::Func if export.name == "cz_tick" => {
                            tick_export = Some(export.index)
                        }
                        ExternalKind::Func => {
                            issues.push(format!("function export {} is not allowed", export.name))
                        }
                        ExternalKind::Memory | ExternalKind::Global => {}
                        _ => issues.push(format!(
                            "export {} has a kind v1 does not allow",
                            export.name
                        )),
                    }
                }
            }
            Payload::StartSection { .. } => issues.push("start functions are not allowed".into()),
            _ => {}
        }
    }

    match tick_export {
        None => issues.push("missing export cz_tick".into()),
        Some(func) => {
            let local = (func as usize).checked_sub(imported_funcs.len());
            let ty = local
                .and_then(|i| local_funcs.get(i))
                .and_then(|t| func_types.get(*t as usize));
            if ty.is_none_or(|(p, r)| !p.is_empty() || !r.is_empty()) {
                issues.push("cz_tick must be a local function of type () -> ()".into());
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}
