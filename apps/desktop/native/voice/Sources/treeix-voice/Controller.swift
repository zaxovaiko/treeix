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
/// A pause this long while speaking types what was said so far, so text lands as you talk instead of on release
// ponytail: fixed pause and a level floor relative to the loudest window; a VAD model if noisy rooms cut mid-word
private let pauseSeconds = 0.8
private let window = Recorder.sampleRate / 10

/// The loudest 0.1 s window's RMS
private func loudness(_ samples: ArraySlice<Float>) -> Float {
    stride(from: samples.startIndex, to: samples.endIndex, by: window).map { start in
        let part = samples[start..<min(start + window, samples.endIndex)]
        return (part.reduce(0) { $0 + $1 * $1 } / Float(part.count)).squareRoot()
    }.max() ?? 0
}

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
    /// Transcripts sent to the plugin, by id, waiting for their `insert`
    private var pending: [Int: (target: NSRunningApplication?, continues: Bool, dictation: Int)] = [:]
    private var nextId = 0
    private var timer: Timer?
    private var pauseTimer: Timer?
    /// Bumped by each dictation, so a cancelled one's late transcripts are dropped
    private var dictation = 0
    /// Samples already sent off as earlier pieces of this dictation
    private var consumed = 0
    /// Pieces being transcribed or waiting for their insert; the dictation ends once none are left
    private var outstanding = 0
    private var transcribing: Task<Void, Never>?
    private var spoke = false
    /// Pieces that couldn't be pasted, so the clipboard holds the whole dictation and not just its last piece
    private var copied = ""
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
        hotkey.chord = HotkeyChord(message["hotkey"] as? [String] ?? [])
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
        dictation += 1
        consumed = 0
        outstanding = 0
        spoke = false
        copied = ""
        if sounds { NSSound(named: "Tink")?.play() }
        hud.model.icon = target?.icon
        hud.show(.listening(handsFree: false))
        timer = Timer.scheduledTimer(withTimeInterval: maxSeconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.finish() } }
        pauseTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.typeOnPause() } }
    }

    private func cancel() {
        timer?.invalidate()
        pauseTimer?.invalidate()
        if case .recording = phase { _ = recorder.stop() }
        dictation += 1
        pending.removeAll()
        phase = .idle
        hud.hide()
    }

    /// Sends what was said up to a pause, while the key is still held
    private func typeOnPause() {
        guard case .recording = phase else { return }
        let fresh = recorder.samples(from: consumed)
        let quiet = Int(pauseSeconds * 10) * window
        guard fresh.count >= minSamples + quiet else { return }
        let loudest = loudness(fresh[...])
        guard loudest >= silence, loudness(fresh.suffix(quiet)) < max(silence, loudest * 0.15) else { return }
        consumed += fresh.count
        enqueue(fresh, last: false)
    }

    private func finish() {
        timer?.invalidate()
        pauseTimer?.invalidate()
        let (samples, _) = recorder.stop()
        if sounds { NSSound(named: "Pop")?.play() }
        let rest = samples.count > consumed ? Array(samples[consumed...]) : []
        phase = .busy
        if rest.count >= minSamples, loudness(rest[...]) >= silence {
            hud.show(.transcribing)
            enqueue(rest, last: true)
        } else if !spoke && outstanding == 0 {
            phase = .idle
            return hud.flash("Nothing heard")
        }
        settle()
    }

    /// Transcribes pieces one after another, so they're typed in the order they were said
    private func enqueue(_ samples: [Float], last: Bool) {
        outstanding += 1
        let previous = transcribing
        let target = self.target
        let dictation = self.dictation
        transcribing = Task {
            await previous?.value
            do {
                let text = try await transcriber.transcribe(samples)
                self.transcribed(text, target: target, dictation: dictation, last: last)
            } catch {
                guard dictation == self.dictation else { return }
                self.outstanding -= 1
                send(["type": "error", "message": error.localizedDescription])
                if case .busy = self.phase, !self.spoke { self.phase = .idle; return self.hud.flash("Couldn't transcribe") }
                self.settle()
            }
        }
    }

    private func transcribed(_ text: String, target: NSRunningApplication?, dictation: Int, last: Bool) {
        guard dictation == self.dictation else { return }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            outstanding -= 1
            if last && !spoke && outstanding == 0 { phase = .idle; return hud.flash("Nothing heard") }
            return settle()
        }
        nextId += 1
        let id = nextId
        let continues = spoke
        pending[id] = (target, continues, dictation)
        spoke = true
        if formatting, case .busy = phase { hud.show(.formatting) }
        send(["type": "transcript", "id": id, "text": text, "app": target?.localizedName ?? NSNull(), "continues": continues])
        DispatchQueue.main.asyncAfter(deadline: .now() + insertTimeout) { [weak self] in
            guard let self, self.pending.removeValue(forKey: id) != nil else { return }
            self.outstanding -= 1
            self.settle()
        }
    }

    private func insert(_ id: Int, _ text: String) {
        guard let piece = pending.removeValue(forKey: id) else { return }
        outstanding -= 1
        if !text.isEmpty {
            let text = piece.continues ? " " + text : text
            if Inserter.insert(text, into: piece.target) == .clipboard {
                copied += text
                if copied != text { Inserter.copy(copied) }
            }
        }
        settle()
    }

    /// Ends the dictation once it's released and every piece is typed
    private func settle() {
        guard case .busy = phase, outstanding == 0 else { return }
        phase = .idle
        if copied.isEmpty { hud.hide() } else { hud.flash("Copied, press ⌘V to paste") }
    }
}
