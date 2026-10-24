import AVFoundation
import CoreAudio

struct RecorderError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

private func check(_ status: OSStatus, _ step: String) throws {
    guard status == noErr else { throw RecorderError("\(step) failed (\(status))") }
}

private func globalAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

struct AudioProcess {
    let objectID: AudioObjectID
    let bundleID: String
    let isUsingMicrophone: Bool
}

/// Core Audio's view of every process with audio open (macOS 14+, no permission needed)
enum AudioProcesses {
    static func all() -> [AudioProcess] {
        var address = globalAddress(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.map { AudioProcess(objectID: $0, bundleID: bundleID(of: $0) ?? "", isUsingMicrophone: isRunningInput($0)) }
    }

    private static func bundleID(of id: AudioObjectID) -> String? {
        var address = globalAddress(kAudioProcessPropertyBundleID)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value?.takeRetainedValue() as String?
    }

    private static func isRunningInput(_ id: AudioObjectID) -> Bool {
        var address = globalAddress(kAudioProcessPropertyIsRunningInput)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr && value == 1
    }
}

/// 16 kHz mono 16-bit PCM in CAF: what the speech models take, and readable up to the last write if the helper dies.
/// Every track keeps to the meeting's clock: a late start or a device that dropped out is written as silence, so the tracks stay aligned
final class TrackWriter {
    static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    /// Buffers arrive a little late or early; only a gap longer than this is filled
    private static let slack = AVAudioFramePosition(format.sampleRate / 5)
    private let file: AVAudioFile
    private let start: UInt64
    private var converter: AVAudioConverter?
    private var written: AVAudioFramePosition = 0
    /// Buffers are dropped while paused; the gap is written as silence on resume, so the tracks stay aligned
    // ponytail: set from the main thread, read on the audio thread unlocked; a Bool tears no worse than one late buffer
    var paused = false

    /// `start` is the host time the meeting's recording began
    init(output: URL, start: UInt64) throws {
        file = try AVAudioFile(
            forWriting: output,
            settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false],
            commonFormat: .pcmFormatFloat32, interleaved: false)
        self.start = start
    }

    /// `hostTime` is when the buffer's first sample was captured, 0 when unknown; a buffer in a new format (the device changed) gets a new converter
    func write(_ buffer: AVAudioPCMBuffer, at hostTime: UInt64) {
        guard !paused else { return }
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: Self.format)
            converter?.downmix = true
        }
        guard let converter else { return }
        if hostTime > start {
            let due = AVAudioFramePosition(AVAudioTime.seconds(forHostTime: hostTime - start) * Self.format.sampleRate)
            if due - written > Self.slack { writeSilence(due - written) }
        }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.format.sampleRate / buffer.format.sampleRate) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: capacity) else { return }
        var given = false
        converter.convert(to: converted, error: nil) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        append(converted)
    }

    private func writeSilence(_ frames: AVAudioFramePosition) {
        var left = frames
        while left > 0 {
            let chunk = AVAudioFrameCount(min(left, AVAudioFramePosition(Self.format.sampleRate) * 10))
            guard let silence = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: chunk) else { return }
            silence.frameLength = chunk
            append(silence)
            left -= AVAudioFramePosition(chunk)
        }
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, (try? file.write(from: buffer)) != nil else { return }
        written += AVAudioFramePosition(buffer.frameLength)
    }
}

/// What the call app plays, the other participants, through a Core Audio process tap. The tap is made again when the output device,
/// its sample rate (AirPods switch between 48 and 24 kHz as a call takes their mic) or the app's audio processes change
@available(macOS 14.2, *)
final class ProcessTapRecorder {
    private let appBundlePrefix: String
    let writer: TrackWriter
    /// Opens and closes the tap and hears about device changes; the audio itself is written on `io`
    private let control = DispatchQueue(label: "treeix.meetings.tap.control")
    private let io = DispatchQueue(label: "treeix.meetings.tap")
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var processIDs: [AudioObjectID] = []
    private var listeners: [(object: AudioObjectID, address: AudioObjectPropertyAddress, block: AudioObjectPropertyListenerBlock)] = []

    init(appBundlePrefix: String, output: URL, start: UInt64) throws {
        self.appBundlePrefix = appBundlePrefix
        writer = try TrackWriter(output: output, start: start)
        try control.sync {
            try open()
            let system = AudioObjectID(kAudioObjectSystemObject)
            listen(system, kAudioHardwarePropertyDefaultSystemOutputDevice) { [weak self] in self?.reopen() }
            listen(system, kAudioHardwarePropertyProcessObjectList) { [weak self] in
                guard let self, self.matchingProcesses() != self.processIDs else { return }
                self.reopen()
            }
        }
    }

    func stop() {
        control.sync {
            for listener in listeners {
                var address = listener.address
                AudioObjectRemovePropertyListenerBlock(listener.object, &address, control, listener.block)
            }
            listeners = []
            close()
        }
    }

    private func matchingProcesses() -> [AudioObjectID] {
        AudioProcesses.all().filter { $0.bundleID.hasPrefix(appBundlePrefix) }.map(\.objectID).sorted()
    }

    private func listen(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ changed: @escaping () -> Void) {
        var address = globalAddress(selector)
        let block: AudioObjectPropertyListenerBlock = { _, _ in changed() }
        guard AudioObjectAddPropertyListenerBlock(object, &address, control, block) == noErr else { return }
        listeners.append((object, address, block))
    }

    /// A tap that can't be made now, such as while the app has no audio open, waits for the next change
    private func reopen() {
        close()
        try? open()
    }

    private func open() throws {
        processIDs = matchingProcesses()
        guard !processIDs.isEmpty else { throw RecorderError("\(appBundlePrefix) has no audio open") }

        let tap = CATapDescription(stereoMixdownOfProcesses: processIDs)
        tap.uuid = UUID()
        tap.muteBehavior = .unmuted
        tap.isPrivate = true
        try check(AudioHardwareCreateProcessTap(tap, &tapID), "Creating the audio tap")

        let outputUID = try Self.defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Treeix meeting tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tap.uuid.uuidString]],
        ]
        do {
            try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "Creating the tap device")

            var address = globalAddress(kAudioTapPropertyFormat)
            var description = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            try check(AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description), "Reading the tap format")
            // The tap reports the app's rate, but buffers come at the device's: 24 kHz for AirPods while a call holds their mic
            description.mSampleRate = try Self.nominalSampleRate(of: aggregateID)
            guard let format = AVAudioFormat(streamDescription: &description) else { throw RecorderError("Unknown tap format") }

            let writer = writer
            try check(
                AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, io) { _, input, inputTime, _, _ in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                    let valid = inputTime.pointee.mFlags.contains(.hostTimeValid)
                    writer.write(buffer, at: valid ? inputTime.pointee.mHostTime : 0)
                }, "Starting the tap")
            try check(AudioDeviceStart(aggregateID, ioProcID), "Starting the tap device")
            listen(aggregateID, kAudioDevicePropertyNominalSampleRate) { [weak self] in self?.reopen() }
        } catch {
            close()
            throw error
        }
    }

    private func close() {
        let aggregate = aggregateID
        listeners.removeAll { listener in
            guard listener.object == aggregate else { return false }
            var address = listener.address
            AudioObjectRemovePropertyListenerBlock(listener.object, &address, control, listener.block)
            return true
        }
        if let ioProcID {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    private static func nominalSampleRate(of device: AudioObjectID) throws -> Float64 {
        var address = globalAddress(kAudioDevicePropertyNominalSampleRate)
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate), "Reading the tap device's sample rate")
        return rate
    }

    private static func defaultOutputDeviceUID() throws -> String {
        var address = globalAddress(kAudioHardwarePropertyDefaultSystemOutputDevice)
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID), "Finding the output device")
        address = globalAddress(kAudioDevicePropertyDeviceUID)
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        try check(AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid), "Reading the output device")
        return (uid?.takeRetainedValue() as String?) ?? ""
    }
}

/// The local microphone: you, or the whole room. A device that changes or goes away stops the engine for good, so a new one starts on what's there now
final class MicRecorder {
    private var engine = AVAudioEngine()
    let writer: TrackWriter
    private var observer: NSObjectProtocol?
    private var stopped = false

    init(output: URL, start: UInt64) throws {
        writer = try TrackWriter(output: output, start: start)
        try begin()
    }

    private func begin() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecorderError("No microphone") }
        let writer = writer
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, when in writer.write(buffer, at: when.isHostTimeValid ? when.hostTime : 0) }
        try engine.start()
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart()
        }
    }

    private func end() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func restart() {
        guard !stopped else { return }
        end()
        engine = AVAudioEngine()
        do {
            try begin()
        } catch {
            // No input device for a moment, such as while AirPods reconnect
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.restart() }
        }
    }

    func stop() {
        stopped = true
        end()
    }
}

enum Track {
    static let others = "others.caf"
    static let mic = "me.caf"
    static let mixed = "meeting.m4a"
}

/// One meeting being recorded into its folder; either track alone is still worth keeping
final class Recording {
    let folder: String
    private let mic: MicRecorder?
    /// A ProcessTapRecorder, which needs macOS 14.2
    private let tap: AnyObject?
    var paused = false {
        didSet {
            mic?.writer.paused = paused
            if #available(macOS 14.2, *) { (tap as? ProcessTapRecorder)?.writer.paused = paused }
        }
    }

    init(folder: String, app: String) throws {
        self.folder = folder
        let url = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let start = mach_absolute_time()
        // The microphone first: the tap takes a few seconds to start and the call's first words are often yours
        do {
            mic = try MicRecorder(output: url.appendingPathComponent(Track.mic), start: start)
        } catch {
            mic = nil
            sendError("Couldn't record the microphone: \(error.localizedDescription)", folder: nil)
        }
        if app.isEmpty {
            tap = nil
        } else if #unavailable(macOS 14.2) {
            tap = nil
            sendError("Recording the call audio needs macOS 14.2 or later", folder: nil)
        } else {
            do {
                tap = try ProcessTapRecorder(appBundlePrefix: app, output: url.appendingPathComponent(Track.others), start: start)
            } catch {
                tap = nil
                sendError("Couldn't record the call audio: \(error.localizedDescription)", folder: nil)
            }
        }
        if mic == nil && tap == nil { throw RecorderError("Neither the microphone nor the call audio could be recorded") }
    }

    func stop() {
        if #available(macOS 14.2, *) { (tap as? ProcessTapRecorder)?.stop() }
        mic?.stop()
    }
}

/// Mixes the tracks into a mono meeting.m4a; false when that failed
func mixTracks(in folder: URL) async -> Bool {
    let tracks = [Track.others, Track.mic].map { folder.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    guard !tracks.isEmpty else { return true }
    let output = folder.appendingPathComponent(Track.mixed)
    do {
        let composition = AVMutableComposition()
        for url in tracks {
            let asset = AVURLAsset(url: url)
            let duration = try await asset.load(.duration)
            // An empty track, such as call audio from an app that played nothing, makes the reader fail
            guard duration > .zero, let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try track?.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: .zero)
        }
        try? FileManager.default.removeItem(at: output)
        try await writeMonoMix(of: composition, to: output)
        return true
    } catch {
        try? FileManager.default.removeItem(at: output)
        sendError("Couldn't save the meeting audio: \(error.localizedDescription)", folder: nil)
        return false
    }
}

func removeTracks(in folder: URL) {
    for name in [Track.others, Track.mic] { try? FileManager.default.removeItem(at: folder.appendingPathComponent(name)) }
}

/// Apple's export presets only write ~175 kbps stereo; a mono mix is a third of that
private func writeMonoMix(of asset: AVAsset, to output: URL) async throws {
    let reader = try AVAssetReader(asset: asset)
    let mix = AVAssetReaderAudioMixOutput(
        audioTracks: try await asset.loadTracks(withMediaType: .audio),
        audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
        ])
    reader.add(mix)
    let writer = try AVAssetWriter(outputURL: output, fileType: .m4a)
    let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 48_000])
    writer.add(input)

    reader.startReading()
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    while let buffer = mix.copyNextSampleBuffer() {
        while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(10)) }
        input.append(buffer)
    }
    input.markAsFinished()
    await writer.finishWriting()
    guard reader.status == .completed, writer.status == .completed else { throw writer.error ?? reader.error ?? RecorderError("Mixing failed") }
}
