import Testing
@testable import MeetingsHelper

private func timed(_ pieces: [(String, Double)]) -> [TimedToken] { pieces.map { TimedToken(text: $0.0, start: $0.1, end: $0.1 + 0.2) } }

@Test func piecesJoinIntoWords() {
    let joined = words(timed([(" Good", 0), (" mor", 0.3), ("ning", 0.5), ("▁all", 0.8), (".", 1.0)]))
    #expect(joined.map(\.text) == ["Good", "morning", "all."])
    #expect(joined[1].end == 0.7)
}

@Test func micEchoOfTheCallIsDropped() {
    let call = words(timed([(" Good", 1), (" morning", 1.3), (" everyone", 1.6)]))
    let mic = markingEcho(words(timed([(" good", 1.1), (" morning", 1.4), (" everyone!", 1.7), (" Hi", 9), (" there", 9.3)])), heard: call)
    let said = utterances(words: mic, turns: [], fallbackSpeaker: "Me")
    #expect(said.map(\.text) == ["Hi there"])
    #expect(said[0].start == 9)
}

@Test func punctuationAloneIsNoUtterance() {
    #expect(utterances(words: words(timed([(" .", 3)])), turns: [], fallbackSpeaker: "Speaker 1").isEmpty)
}

@Test func lettersAreCountedPerAlphabet() {
    #expect(scriptLetters("Dzień добрий 42") == [.latin: 5, .cyrillic: 6])
}
