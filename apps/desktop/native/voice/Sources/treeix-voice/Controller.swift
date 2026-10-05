import AVFoundation
import AppKit

/// Holding the key shorter than this is a tap, which keeps listening hands-free
private let tapSeconds = 0.35
private let maxSeconds = 300.0
private let minSamples = Recorder.sampleRate * 3 / 10
/// RMS below this for the whole recording is silence
private let silence: Float = 0.004
/// The plugin answers a transcript with `insert`; past this it is gone and the next dictation may start
private let insertTimeout = 20.0

@MainActor
final class Controller {
    private enum Phase { case idle, recording(handsFree: Bool), busy }

    private let hud = HUD()
    private let recorder = Recorder()
    private let transcriber = Transcriber()
    private let hotkey = Hotkey()
    private var phase = Phase.idle
    private var pressedAt = Date()
    private var target: NSRunningApplication?
    private var pending: [Int: NSRunningApplication?] = [:]
    private var nextId = 0
    private var timer: Timer?
    private var tapToToggle = true
    private var sounds = true
    private var formatting = false
    private var selected: String?
    private var states: [String: [String: Any]] = [:]

    init() {
        hotkey.onPress = { [weak self] in self?.pressed() }
        hotkey.onRelease = { [weak self] in self?.released() }
        hotkey.onOtherKey = { [weak self] in self?.otherKey() }
        hotkey.onEscape = { [weak self] in self?.escape() }
        recorder.onLevel = { [weak self] level in self?.hud.model.push(level) }
    }

    func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "configure": configure(message)
        case "download": if let id = message["model"] as? String { download(id) }
        case "delete": if let id = message["model"] as? String { delete(id) }
        case "insert":
            if let id = message["id"] as? Int, let text = message["text"] as? String { insert(id, text) }
        default: break
        }
    }

    // MARK: Settings and models

    private func configure(_ message: [String: Any]) {
        hotkey.key = HotkeyKey(rawValue: message["hotkey"] as? String ?? "") ?? .rightOption
        tapToToggle = message["tapToToggle"] as? Bool ?? true
        sounds = message["sounds"] as? Bool ?? true
        formatting = message["formatting"] as? Bool ?? false
        if let path = message["modelsPath"] as? String { transcriber.root = URL(fileURLWithPath: path, isDirectory: true) }
        let model = message["model"] as? String
        if model != selected || states.isEmpty {
            selected = model
            refreshStates()
            if let model, transcriber.exists(model) { load(model) }
        }
    }

    private func refreshStates() {
        for id in Transcriber.models where states[id]?["state"] as? String != "downloading" {
            states[id] = ["id": id, "state": transcriber.exists(id) ? "downloaded" : "missing"]
        }
        if let loaded = transcriber.loaded, loaded == selected { states[loaded] = ["id": loaded, "state": "ready"] }
        sendStates()
    }

    private func setState(_ id: String, _ state: String, _ extra: [String: Any] = [:]) {
        states[id] = ["id": id, "state": state].merging(extra) { $1 }
        sendStates()
    }

    private func sendStates() {
        send(["type": "models", "models": Transcriber.models.compactMap { states[$0] }])
    }

    private func download(_ id: String) {
        guard Transcriber.models.contains(id), states[id]?["state"] as? String != "downloading" else { return }
        setState(id, "downloading", ["progress": 0.0])
        var reported = 0
        Task {
            do {
                try await transcriber.download(id) { fraction in
                    let percent = Int(fraction * 100)
                    DispatchQueue.main.async {
                        guard percent > reported else { return }
                        reported = percent
                        self.setState(id, "downloading", ["progress": fraction])
                    }
                }
                await MainActor.run {
                    self.setState(id, "downloaded")
                    if id == self.selected { self.load(id) }
                }
            } catch {
                await MainActor.run { self.setState(id, "error", ["error": error.localizedDescription]) }
            }
        }
    }

    private func load(_ id: String) {
        setState(id, "loading")
        Task {
            do {
                try await transcriber.load(id)
                await MainActor.run {
                    // Another model was picked while this one loaded
                    if self.selected == id { self.setState(id, "ready") } else { self.refreshStates() }
                }
            } catch {
                await MainActor.run { self.setState(id, "error", ["error": error.localizedDescription]) }
            }
        }
    }

    private func delete(_ id: String) {
        guard states[id]?["state"] as? String != "downloading" else { return }
        do {
            try transcriber.delete(id)
        } catch {
            send(["type": "error", "message": error.localizedDescription])
        }
        refreshStates()
    }

    // MARK: Hotkey

    private func pressed() {
        switch phase {
        case .recording(handsFree: true): finish()
        case .idle: start()
        default: break
        }
    }

    private func released() {
        guard case .recording(handsFree: false) = phase else { return }
        if Date().timeIntervalSince(pressedAt) >= tapSeconds { return finish() }
        guard tapToToggle else { return cancel() }
        phase = .recording(handsFree: true)
        hud.show(.listening(handsFree: true))
    }

    /// The key went into a shortcut such as ⌥A for a special character, so this wasn't dictation
    private func otherKey() {
        if case .recording(handsFree: false) = phase { cancel() }
    }

    private func escape() {
        guard case .recording = phase else { return }
        cancel()
        hud.flash("Cancelled")
    }

    // MARK: Recording

    private func start() {
        guard let selected, transcriber.loaded == selected else {
            let state = selected.flatMap { states[$0]?["state"] as? String }
            return hud.flash(state == "loading" ? "Loading the speech model…" : "Download a speech model in Treeix Settings")
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            return hud.flash("Allow the microphone in Treeix Settings")
        }
        do {
            try recorder.start()
        } catch {
            return hud.flash(error.localizedDescription)
        }
        target = NSWorkspace.shared.frontmostApplication
        pressedAt = Date()
        phase = .recording(handsFree: false)
        if sounds { NSSound(named: "Tink")?.play() }
        hud.model.icon = target?.icon
        hud.show(.listening(handsFree: false))
        timer = Timer.scheduledTimer(withTimeInterval: maxSeconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.finish() } }
    }

    private func cancel() {
        timer?.invalidate()
        if case .recording = phase { _ = recorder.stop() }
        phase = .idle
        hud.hide()
    }

    private func finish() {
        timer?.invalidate()
        let (samples, peak) = recorder.stop()
        if sounds { NSSound(named: "Pop")?.play() }
        guard samples.count >= minSamples, peak >= silence else {
            phase = .idle
            return hud.flash("Nothing heard")
        }
        phase = .busy
        hud.show(.transcribing)
        let target = self.target
        Task {
            do {
                let text = try await transcriber.transcribe(samples)
                await MainActor.run { self.transcribed(text, target: target) }
            } catch {
                await MainActor.run {
                    self.phase = .idle
                    self.hud.flash("Couldn't transcribe")
                    send(["type": "error", "message": error.localizedDescription])
                }
            }
        }
    }

    private func transcribed(_ text: String, target: NSRunningApplication?) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            phase = .idle
            return hud.flash("Nothing heard")
        }
        nextId += 1
        let id = nextId
        pending[id] = target
        if formatting { hud.show(.formatting) }
        send(["type": "transcript", "id": id, "text": text, "app": target?.localizedName ?? NSNull()])
        DispatchQueue.main.asyncAfter(deadline: .now() + insertTimeout) { [weak self] in
            guard let self, self.pending.removeValue(forKey: id) != nil else { return }
            self.phase = .idle
            self.hud.hide()
        }
    }

    private func insert(_ id: Int, _ text: String) {
        guard let target = pending.removeValue(forKey: id) else { return }
        phase = .idle
        guard !text.isEmpty else { return hud.hide() }
        if Inserter.insert(text, into: target) == .clipboard { hud.flash("Copied, press ⌘V to paste") } else { hud.hide() }
    }
}
