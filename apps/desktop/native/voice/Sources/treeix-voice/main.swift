import AppKit

/// One JSON object per line on stdout; the plugin skips lines that aren't its messages
func send(_ message: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

let app = NSApplication.shared
// No Dock icon or menu bar; the HUD is the only window
app.setActivationPolicy(.accessory)
let controller = MainActor.assumeIsolated { Controller() }

Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
            let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { continue }
        // A queue keeps messages in order, which separate Tasks do not promise
        DispatchQueue.main.async { MainActor.assumeIsolated { controller.handle(message) } }
    }
    // Treeix quit or the plugin was turned off
    exit(0)
}

send(["type": "ready"])
app.run()
