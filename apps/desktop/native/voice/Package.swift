// swift-tools-version: 6.0
import PackageDescription

// Treeix's dictation helper: hotkey, microphone, on-device speech recognition, the HUD and pasting.
// The dictation plugin runs it and talks to it in JSON lines over stdin and stdout.
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
        )
    ]
)
