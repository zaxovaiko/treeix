import CoreMediaIO
import FluidAudio
import Foundation

private let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

func isoString(_ date: Date) -> String { iso.string(from: date) }
private func isoDate(_ value: Any?) -> Date? { (value as? String).flatMap(iso.date) }

/// Answers the meetings plugin: who uses the microphone, recording, transcripts and the calendar
@MainActor
final class Meetings {
    private var modelsPath = FileManager.default.temporaryDirectory
    private var recording: Recording?
    private var micApps: [String] = []
    private var camera = false
    private let calendar = MeetingCalendar()
    private let transcriber = Transcriber()
    /// Transcriptions run one at a time; the models are let go once none is waiting
    private var transcriptions: Task<Void, Never>?
    private var queued = 0

    init() {
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { self.pollMicrophone() }
        }
    }

    func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "configure":
            if let path = message["modelsPath"] as? String { modelsPath = URL(fileURLWithPath: path, isDirectory: true) }
        case "record":
            if let folder = message["folder"] as? String { record(folder: folder, app: message["app"] as? String ?? "") }
        case "stop":
            if let folder = stop() { send(["type": "stopped", "folder": folder]) }
        case "transcribe":
            if let folder = message["folder"] as? String { transcribe(folder: folder, language: Language(rawValue: message["language"] as? String ?? "")) }
        case "calendar":
            let event = calendar.event(at: isoDate(message["at"]) ?? .now, url: message["url"] as? String)
            send(["type": "calendar", "event": event?.json ?? NSNull()])
        case "events":
            let events = calendar.events(from: isoDate(message["from"]) ?? .now, to: isoDate(message["to"]) ?? .now)
            send(["type": "events", "events": events.map(\.json)])
        case "calendarAccess":
            calendar.requestAccess { send(["type": "calendarAccess", "status": $0]) }
        default: break
        }
    }

    /// Bundle ids and whether a camera is on, sent whenever either changes
    private func pollMicrophone() {
        let apps = Set(AudioProcesses.all().filter(\.isUsingMicrophone).map(\.bundleID).filter { !$0.isEmpty }).sorted()
        let cameraOn = cameraInUse()
        guard apps != micApps || cameraOn != camera else { return }
        micApps = apps
        camera = cameraOn
        send(["type": "mic", "apps": apps, "camera": cameraOn])
    }

    private func record(folder: String, app: String) {
        guard recording == nil else { return sendError("Already recording", folder: folder) }
        do {
            recording = try Recording(folder: folder, app: app)
            send(["type": "recording", "folder": folder])
        } catch {
            sendError("Couldn't record: \(error.localizedDescription)", folder: folder)
        }
    }

    /// The folder that was recording
    @discardableResult
    func stop() -> String? {
        guard let recording else { return nil }
        recording.stop()
        self.recording = nil
        return recording.folder
    }

    private func transcribe(folder: String, language: Language?) {
        let previous = transcriptions
        let models = modelsPath
        queued += 1
        transcriptions = Task {
            await previous?.value
            let url = URL(fileURLWithPath: folder, isDirectory: true)
            do {
                let utterances = try await transcriber.transcribe(folder: url, models: models, language: language)
                let mixed = await mixTracks(in: url)
                send(["type": "transcript", "folder": folder, "utterances": utterances.map(\.json)])
                // Without the mix the tracks are the only copy of the audio, so they stay
                if mixed { removeTracks(in: url) }
            } catch {
                sendError("Couldn't transcribe: \(error.localizedDescription)", folder: folder)
            }
            queued -= 1
            if queued == 0 { await transcriber.release() }
        }
    }
}

/// Whether any app has a camera on; a call joined muted holds no microphone but often the camera
private func cameraInUse() -> Bool {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    let system = CMIOObjectID(kCMIOObjectSystemObject)
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return false }
    var devices = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    guard CMIOObjectGetPropertyData(system, &address, 0, nil, size, &size, &devices) == noErr else { return false }
    address.mSelector = CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere)
    return devices.contains { device in
        var running: UInt32 = 0
        var read: UInt32 = 0
        return CMIOObjectGetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &read, &running) == noErr && running != 0
    }
}
