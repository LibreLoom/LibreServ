// The Windows build is a GUI app — no console window next to it.
#![cfg_attr(target_family = "windows", windows_subsystem = "windows")]

mod ui;

fn main() -> glib::ExitCode {
    ui::run()
}
