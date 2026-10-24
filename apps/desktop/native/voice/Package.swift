// swift-tools-version: 6.0
import PackageDescription

// Treeix's native helper, run by its plugins and talking JSON lines over stdin and stdout. One binary, so
// FluidAudio ships once: `treeix-voice` for dictation (hotkey, microphone, speech recognition, the HUD and
// pasting), `treeix-voice meetings` for meetings (call audio, transcripts with speakers, the calendar).
let size: [SwiftSetting] = [.swiftLanguageMode(.v5), .unsafeFlags(["-Osize"], .when(configuration: .release))]

let package = Package(
    name: "treeix-voice",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5")
    ],
    targets: [
        .target(name: "VoiceHelper", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")], swiftSettings: size),
        .target(name: "MeetingsHelper", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")], swiftSettings: size),
        .executableTarget(
            name: "treeix-voice",
            dependencies: ["VoiceHelper", "MeetingsHelper"],
            swiftSettings: size,
            linkerSettings: [.unsafeFlags(["-Xlinker", "-dead_strip"], .when(configuration: .release))]
        ),
        .testTarget(name: "MeetingsHelperTests", dependencies: ["MeetingsHelper"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
