import AVFoundation

/// The default input device, converted to the 16 kHz mono samples Parakeet takes; the microphone is open only while recording
final class Recorder: @unchecked Sendable {
    static let sampleRate = 16_000

    /// RMS of each buffer, on the main thread, for the HUD's meter
    var onLevel: (@MainActor (Float) -> Void)?

    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var samples: [Float] = []
    private var peak: Float = 0

    func start() throws {
        // A fresh engine each time follows the current default input, e.g. AirPods connected since the last dictation
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0, let converter = AVAudioConverter(from: inputFormat, to: format) else {
            throw VoiceError("No microphone found")
        }
        lock.withLock {
            samples = []
            peak = 0
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in self?.append(buffer, converter) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw VoiceError("Couldn't start the microphone")
        }
        self.engine = engine
    }

    /// The samples so far and the loudest buffer's RMS
    func stop() -> (samples: [Float], peak: Float) {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        return lock.withLock { (samples, peak) }
    }

    private func append(_ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter) {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        // noDataNow keeps the converter's resampling state between buffers, unlike endOfStream
        converter.convert(to: converted, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = converted.floatChannelData?[0], converted.frameLength > 0 else { return }
        let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
        let rms = (chunk.reduce(0) { $0 + $1 * $1 } / Float(chunk.count)).squareRoot()
        lock.withLock {
            samples += chunk
            peak = max(peak, rms)
        }
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.onLevel?(rms) } }
    }
}
