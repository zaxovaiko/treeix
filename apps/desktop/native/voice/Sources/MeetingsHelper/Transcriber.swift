import AVFoundation
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

/// One word with its timing; `echo` when it's the call audio heard again through the microphone
struct Word {
    var text: String
    let start: Double
    var end: Double
    var echo = false
}

/// A pause this long ends an utterance, so another track's speaker can be slotted in between
let utterancePause = 1.0

/// Parakeet's word pieces joined into words; a piece starting with a space or ▁ starts a new one
func words(_ tokens: [TimedToken]) -> [Word] {
    let boundary = { (character: Character) in character == " " || character == "▁" }
    var words: [Word] = []
    for token in tokens {
        if token.text.first.map(boundary) ?? false || words.isEmpty {
            words.append(Word(text: String(token.text.drop(while: boundary)), start: token.start, end: token.end))
        } else {
            words[words.count - 1].text += token.text
            words[words.count - 1].end = token.end
        }
    }
    return words.filter { !$0.text.isEmpty }
}

private func spoken(_ word: String) -> String { String(word.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains)) }

/// Without headphones the microphone hears the speakers too: its words the call audio has within `window` seconds are marked as echo
func markingEcho(_ mic: [Word], heard others: [Word], window: Double = 1.5) -> [Word] {
    var heard: [String: [Double]] = [:]
    for word in others { heard[spoken(word.text), default: []].append(word.start) }
    return mic.map { word in
        var marked = word
        let key = spoken(word.text)
        marked.echo = !key.isEmpty && (heard[key] ?? []).contains { abs($0 - word.start) <= window }
        return marked
    }
}

/// Each word goes to the turn covering its midpoint, else the nearest turn; runs of one speaker are joined until a pause.
/// A run that is mostly echo is dropped whole, since the microphone mishears the rest of it
func utterances(words: [Word], turns: [SpeakerTurn], fallbackSpeaker: String) -> [Utterance] {
    func distance(_ turn: SpeakerTurn, _ time: Double) -> Double { max(turn.start - time, time - turn.end, 0) }
    func speaker(at time: Double) -> String {
        if let turn = turns.first(where: { $0.start <= time && time <= $0.end }) { return turn.speaker }
        return turns.min { distance($0, time) < distance($1, time) }?.speaker ?? fallbackSpeaker
    }

    var runs: [(speaker: String, start: Double, words: [Word])] = []
    var previousEnd = -Double.infinity
    for word in words {
        let who = speaker(at: (word.start + word.end) / 2)
        if runs.last?.speaker == who && word.start - previousEnd < utterancePause {
            runs[runs.count - 1].words.append(word)
        } else {
            runs.append((who, word.start, [word]))
        }
        previousEnd = word.end
    }
    return runs.compactMap { run in
        let kept = run.words.filter { !$0.echo }
        guard kept.count * 2 > run.words.count else { return nil }
        let text = kept.map(\.text).joined(separator: " ")
        // A lone full stop or comma after a pause is no utterance
        guard text.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains) else { return nil }
        return Utterance(speaker: run.speaker, start: kept[0].start, text: text)
    }
}

/// Letters of each script Parakeet writes in; others (digits, punctuation, Greek) aren't counted
func scriptLetters(_ text: String) -> [Script: Int] {
    var counts: [Script: Int] = [:]
    for scalar in text.unicodeScalars where scalar.properties.isAlphabetic {
        switch scalar.value {
        case 0x41...0x24F, 0x1E00...0x1EFF: counts[.latin, default: 0] += 1
        case 0x400...0x4FF: counts[.cyrillic, default: 0] += 1
        default: break
        }
    }
    return counts
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

    /// `language` keeps Parakeet to its alphabet, so a Polish call has no Cyrillic words in it. Without one, a track written in
    /// two alphabets, or in another than the rest of the meeting, is transcribed again in each and kept in the one Parakeet is surer of
    func transcribe(folder: URL, models: URL, language: Language?) async throws -> [Utterance] {
        let separate: [(file: String, names: ([SpeakerTurn]) -> [String: String], fallback: String)] = [
            (Track.others, remoteSpeakerNames, "Speaker 1"),
            (Track.mic, micSpeakerNames, "Me"),
        ]
        // Parakeet needs 0.3s; the call audio is empty when the app played nothing, such as a call you had muted
        let recorded = { (file: String) in
            (try? AVAudioFile(forReading: folder.appendingPathComponent(file))).map { Double($0.length) / $0.fileFormat.sampleRate >= 0.3 } ?? false
        }
        // Meetings whose tracks were already mixed have only meeting.m4a
        let tracks = separate.contains { recorded($0.file) } ? separate.filter { recorded($0.file) } : [(Track.mixed, remoteSpeakerNames, "Speaker 1")].filter { recorded($0.0) }
        guard !tracks.isEmpty else { throw RecorderError("No audio was recorded") }

        let asr = try await asrManager(models)
        let diarizer = try await diarizerManager(models)
        let urls = tracks.map { folder.appendingPathComponent($0.file) }
        var results: [ASRResult] = []
        for url in urls { results.append(try await recognize(url, asr: asr, language: language)) }
        if language == nil {
            let meeting = results.map { scriptLetters($0.text) }.reduce(into: [Script: Int]()) { total, counts in total.merge(counts, uniquingKeysWith: +) }
            let main = meeting.max { $0.value < $1.value }?.key
            for (index, result) in results.enumerated() {
                let scripts = scriptLetters(result.text).filter { $0.value > 0 }
                guard scripts.count > 1 || (scripts.count == 1 && scripts.keys.first != main) else { continue }
                let latin = try await recognize(urls[index], asr: asr, language: .english)
                let cyrillic = try await recognize(urls[index], asr: asr, language: .ukrainian)
                results[index] = latin.confidence >= cyrillic.confidence ? latin : cyrillic
            }
        }

        var trackWords = results.map { words(($0.tokenTimings ?? []).map { TimedToken(text: $0.token, start: $0.startTime, end: $0.endTime) }) }
        if let others = tracks.firstIndex(where: { $0.file == Track.others }), let mic = tracks.firstIndex(where: { $0.file == Track.mic }) {
            trackWords[mic] = markingEcho(trackWords[mic], heard: trackWords[others])
        }
        var all: [Utterance] = []
        for (index, track) in tracks.enumerated() {
            // Diarization throws on near-silent tracks, such as a call where only you spoke; the track then has one speaker
            let raw = (try? await diarizer.process(urls[index]).segments.map {
                SpeakerTurn(speaker: $0.speakerId, start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds))
            }) ?? []
            let names = track.names(raw)
            let turns = raw.map { SpeakerTurn(speaker: names[$0.speaker] ?? $0.speaker, start: $0.start, end: $0.end) }
            all += utterances(words: trackWords[index], turns: turns, fallbackSpeaker: track.fallback)
        }
        return interleaved(all)
    }

    private func recognize(_ url: URL, asr: AsrManager, language: Language?) async throws -> ASRResult {
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        return try await asr.transcribe(url, decoderState: &state, language: language)
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
