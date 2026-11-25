//! Usage: cz-validate <module.wasm> <memory_page_limit>

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(path), Some(limit)) = (args.get(1), args.get(2).and_then(|v| v.parse::<u64>().ok()))
    else {
        eprintln!("usage: cz-validate <module.wasm> <memory_page_limit>");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::from(2);
        }
    };
    match cz_validator::check(&bytes, limit) {
        Ok(()) => {
            println!("{path}: passes Construct ABI v1 ({} bytes)", bytes.len());
            ExitCode::SUCCESS
        }
        Err(issues) => {
            for issue in issues {
                eprintln!("{path}: {issue}");
            }
            ExitCode::FAILURE
        }
    }
}
