//! luna-bench: the lunad side of Luna's perf harness (`luna/perf/`).
//!
//! - `luna-bench run`  drives lunad's HTTP API for the server side of the
//!   journeys in `perf/budgets.json` and writes JSON to `perf/results/`.
//! - `luna-bench gen`  writes the test datasets to `perf/data/`.
//!
//! Both are dev tools: nothing here ships. See `luna/perf/README.md`.

mod args;
mod bench;
mod exif_write;
mod generate;
mod stats;

use std::path::PathBuf;

const USAGE: &str = "\
luna-bench: Luna perf harness (see luna/perf/README.md)

USAGE:
  luna-bench run [options]   measure lunad's side of the journeys
  luna-bench gen [options]   write test datasets to perf/data
  luna-bench <cmd> --help    options for one command
";

fn main() {
    let mut argv = std::env::args().skip(1);
    let cmd = argv.next().unwrap_or_default();
    let rest: Vec<String> = argv.collect();
    let result = match cmd.as_str() {
        "run" => bench::main(&rest),
        "gen" => generate::main(&rest),
        "" | "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(anyhow::anyhow!("unknown command {other:?}\n\n{USAGE}")),
    };
    if let Err(e) = result {
        eprintln!("luna-bench: {e:#}");
        std::process::exit(1);
    }
}

/// `luna/perf`, found from this crate's source location.
pub fn perf_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../perf")
}
