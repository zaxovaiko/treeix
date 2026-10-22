import FluidAudio
import Foundation

/// Parakeet models through FluidAudio, kept loaded between dictations so each one takes a fraction of a second
@MainActor
final class Transcriber {
    /// Ids the plugin's model list uses
    static let models = ["parakeet-v3", "parakeet-v2"]

    var root = FileManager.default.temporaryDirectory
    private(set) var loaded: String?
    private var manager: AsrManager?

    private static func version(_ id: String) -> AsrModelVersion { id == "parakeet-v2" ? .v2 : .v3 }

    /// FluidAudio's repo folder, under the plugin's own models folder instead of FluidAudio's shared cache
    private func directory(_ id: String) -> URL {
        root.appendingPathComponent(AsrModels.defaultCacheDirectory(for: Self.version(id)).lastPathComponent, isDirectory: true)
    }

    func exists(_ id: String) -> Bool { AsrModels.modelsExist(at: directory(id), version: Self.version(id)) }

    func download(_ id: String, progress: @escaping @Sendable (Double) -> Void) async throws {
        try await AsrModels.download(to: directory(id), version: Self.version(id)) { progress($0.fractionCompleted) }
    }

    func load(_ id: String) async throws {
        guard loaded != id else { return }
        let models = try await AsrModels.load(from: directory(id), version: Self.version(id))
        let next = AsrManager(config: .default)
        try await next.loadModels(models)
        await manager?.cleanup()
        manager = next
        loaded = id
    }

    func delete(_ id: String) throws {
        if loaded == id {
            loaded = nil
            manager = nil
        }
        let folder = directory(id)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    /// 16 kHz mono samples
    func transcribe(_ samples: [Float]) async throws -> String {
        guard let manager else { throw VoiceError("No speech model is loaded") }
        var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        return try await manager.transcribe(samples, decoderState: &state).text
    }
}

struct VoiceError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
