// swift-tools-version: 6.0
import PackageDescription

// Treeix's native helpers, each run by its plugin and talking JSON lines over stdin and stdout:
// treeix-voice for dictation (hotkey, microphone, speech recognition, the HUD and pasting),
// treeix-meetings for meetings (call audio, transcripts with speakers, the calendar).
let package = Package(
    name: "treeix-voice",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5")
    ],
    targets: [
        .executableTarget(
            name: "treeix-voice",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "treeix-meetings",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
