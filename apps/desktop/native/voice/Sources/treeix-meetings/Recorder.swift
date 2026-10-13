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

/// 16 kHz mono 16-bit PCM in CAF: what the speech models take, and readable up to the last write if the helper dies
final class TrackWriter {
    static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private let file: AVAudioFile
    private let converter: AVAudioConverter

    init(output: URL, input: AVAudioFormat) throws {
        file = try AVAudioFile(
            forWriting: output,
            settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false],
            commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let converter = AVAudioConverter(from: input, to: Self.format) else { throw RecorderError("Can't convert audio from \(input)") }
        converter.downmix = true
        self.converter = converter
    }

    func write(_ buffer: AVAudioPCMBuffer) {
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
        if converted.frameLength > 0 { try? file.write(from: converted) }
    }
}

/// What the call app plays, the other participants, through a Core Audio process tap
@available(macOS 14.2, *)
final class ProcessTapRecorder {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    init(appBundlePrefix: String, output: URL) throws {
        let processIDs = AudioProcesses.all().filter { $0.bundleID.hasPrefix(appBundlePrefix) }.map(\.objectID)
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
            guard let format = AVAudioFormat(streamDescription: &description) else { throw RecorderError("Unknown tap format") }

            let writer = try TrackWriter(output: output, input: format)
            try check(
                AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, DispatchQueue(label: "treeix.meetings.tap")) { _, input, _, _, _ in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                    writer.write(buffer)
                }, "Starting the tap")
            try check(AudioDeviceStart(aggregateID, ioProcID), "Starting the tap device")
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
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

/// The local microphone: you, or the whole room
final class MicRecorder {
    private let engine = AVAudioEngine()

    init(output: URL) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let writer = try TrackWriter(output: output, input: format)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in writer.write(buffer) }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
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

    init(folder: String, app: String) throws {
        self.folder = folder
        let url = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        // The microphone first: the tap takes a few seconds to start and the call's first words are often yours
        do {
            mic = try MicRecorder(output: url.appendingPathComponent(Track.mic))
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
                tap = try ProcessTapRecorder(appBundlePrefix: app, output: url.appendingPathComponent(Track.others))
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
            guard let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try track?.insertTimeRange(CMTimeRange(start: .zero, duration: try await asset.load(.duration)), of: source, at: .zero)
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
