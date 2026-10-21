// Release builds on Windows would open a console window without this
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    treeix_app_lib::run()
}
