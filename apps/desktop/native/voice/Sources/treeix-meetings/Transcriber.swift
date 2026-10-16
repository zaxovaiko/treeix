import FluidAudio
import Foundation

struct TimedToken {
    let text: String
    let start: Double
    let end: Double
}

struct SpeakerTurn {
    let speaker: String
    let start: Double
    let end: Double
}

struct Utterance {
    let speaker: String
    let start: Double
    let text: String

    var json: [String: Any] { ["speaker": speaker, "start": start, "text": text] }
}

/// A pause this long ends an utterance, so another track's speaker can be slotted in between
let utterancePause = 1.0

/// Each token goes to the turn covering its midpoint, else the nearest turn; runs of one speaker are joined until a pause
func utterances(tokens: [TimedToken], turns: [SpeakerTurn], fallbackSpeaker: String) -> [Utterance] {
    func distance(_ turn: SpeakerTurn, _ time: Double) -> Double { max(turn.start - time, time - turn.end, 0) }
    func speaker(at time: Double) -> String {
        if let turn = turns.first(where: { $0.start <= time && time <= $0.end }) { return turn.speaker }
        return turns.min { distance($0, time) < distance($1, time) }?.speaker ?? fallbackSpeaker
    }

    var runs: [(speaker: String, start: Double, text: String)] = []
    var previousEnd = -Double.infinity
    for token in tokens {
        let who = speaker(at: (token.start + token.end) / 2)
        if runs.last?.speaker == who && token.start - previousEnd < utterancePause {
            runs[runs.count - 1].text += token.text
        } else {
            runs.append((who, token.start, token.text))
        }
        previousEnd = token.end
    }
    return runs.compactMap { run in
        let text = run.text.replacingOccurrences(of: "▁", with: " ").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : Utterance(speaker: run.speaker, start: run.start, text: text)
    }
}

/// Every track's utterances in time order, consecutive ones of the same speaker joined back together
func interleaved(_ utterances: [Utterance]) -> [Utterance] {
    var merged: [Utterance] = []
    for utterance in utterances.sorted(by: { $0.start < $1.start }) {
        if let last = merged.last, last.speaker == utterance.speaker {
            merged[merged.count - 1] = Utterance(speaker: last.speaker, start: last.start, text: last.text + " " + utterance.text)
        } else {
            merged.append(utterance)
        }
    }
    return merged
}

/// Microphone: whoever talks most is you, anyone else is in the room with you
func micSpeakerNames(_ turns: [SpeakerTurn]) -> [String: String] {
    let talkTime = Dictionary(grouping: turns, by: \.speaker).mapValues { $0.reduce(0) { $0 + $1.end - $1.start } }
    let ranked = talkTime.sorted { $0.value > $1.value }.map(\.key)
    return Dictionary(uniqueKeysWithValues: ranked.enumerated().map { index, id in (id, index == 0 ? "Me" : "Room \(index)") })
}

/// Call audio: remote speakers numbered in order of first appearance
func remoteSpeakerNames(_ turns: [SpeakerTurn]) -> [String: String] {
    var names: [String: String] = [:]
    for turn in turns.sorted(by: { $0.start < $1.start }) where names[turn.speaker] == nil {
        names[turn.speaker] = "Speaker \(names.count + 1)"
    }
    return names
}

/// Parakeet v3 with token timings plus offline diarization, loaded per batch of meetings and let go after
actor Transcriber {
    private var asr: AsrManager?
    private var diarizer: OfflineDiarizerManager?

    /// `language` keeps Parakeet to its alphabet, so a Polish call has no Cyrillic words in it
    func transcribe(folder: URL, models: URL, language: Language?) async throws -> [Utterance] {
        let separate: [(file: String, names: ([SpeakerTurn]) -> [String: String], fallback: String)] = [
            (Track.others, remoteSpeakerNames, "Speaker 1"),
            (Track.mic, micSpeakerNames, "Me"),
        ]
        let exists = { (file: String) in FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path) }
        // Meetings whose tracks were already mixed have only meeting.m4a
        let tracks = separate.contains { exists($0.file) } ? separate.filter { exists($0.file) } : [(Track.mixed, remoteSpeakerNames, "Speaker 1")].filter { exists($0.0) }
        guard !tracks.isEmpty else { throw RecorderError("No audio was recorded") }

        let asr = try await asrManager(models)
        let diarizer = try await diarizerManager(models)
        var all: [Utterance] = []
        for track in tracks {
            let url = folder.appendingPathComponent(track.file)
            var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
            let result = try await asr.transcribe(url, decoderState: &state, language: language)
            let tokens = (result.tokenTimings ?? []).map { TimedToken(text: $0.token, start: $0.startTime, end: $0.endTime) }
            // Diarization throws on near-silent tracks, such as a call where only you spoke; the track then has one speaker
            let raw = (try? await diarizer.process(url).segments.map {
                SpeakerTurn(speaker: $0.speakerId, start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds))
            }) ?? []
            let names = track.names(raw)
            let turns = raw.map { SpeakerTurn(speaker: names[$0.speaker] ?? $0.speaker, start: $0.start, end: $0.end) }
            all += utterances(tokens: tokens, turns: turns, fallbackSpeaker: track.fallback)
        }
        return interleaved(all)
    }

    /// Frees the models' memory for the LLM that usually runs next
    func release() async {
        await asr?.cleanup()
        asr = nil
        diarizer = nil
    }

    /// Under the shared models folder, next to the ones dictation downloads
    private func asrManager(_ models: URL) async throws -> AsrManager {
        if let asr { return asr }
        let directory = models.appendingPathComponent(AsrModels.defaultCacheDirectory(for: .v3).lastPathComponent, isDirectory: true)
        if !AsrModels.modelsExist(at: directory, version: .v3) { try await AsrModels.download(to: directory, version: .v3) }
        let manager = AsrManager(config: .default)
        try await manager.loadModels(try await AsrModels.load(from: directory, version: .v3))
        asr = manager
        return manager
    }

    private func diarizerManager(_ models: URL) async throws -> OfflineDiarizerManager {
        if let diarizer { return diarizer }
        let manager = OfflineDiarizerManager(config: .default)
        try await manager.prepareModels(directory: models)
        diarizer = manager
        return manager
    }
}
