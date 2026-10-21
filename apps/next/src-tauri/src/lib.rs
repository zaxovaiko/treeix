pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("tauri app failed to start");
}
