import Foundation

/// One JSON object per line on stdout; the plugin skips lines that aren't its messages
func send(_ message: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

func sendError(_ message: String, folder: String?) {
    send(["type": "error", "message": message, "folder": folder ?? NSNull()])
}

let meetings = MainActor.assumeIsolated { Meetings() }

Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
            let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { continue }
        // A queue keeps messages in order, which separate Tasks do not promise
        DispatchQueue.main.async { MainActor.assumeIsolated { meetings.handle(message) } }
    }
    // Treeix quit or the plugin was turned off: close the audio files so they're complete
    DispatchQueue.main.sync { MainActor.assumeIsolated { meetings.stop() } }
    exit(0)
}

send(["type": "ready"])
RunLoop.main.run()
