# 7. Voice dictation

Date: 2026-10-05
Status: Accepted

## Context

Users dictate into agents and every other app with an external tool (FluidVoice): hold a key, speak, and the text lands in the focused input, optionally tidied up by a local model. They want that inside Treeix so the external app can go, and it has to keep working system-wide, not only in Treeix's own inputs.

Engines measured on an M-series Mac:

- Parakeet TDT 0.6B v3 through FluidAudio (Core ML, Neural Engine): 25 European languages, about 100x realtime. Ukrainian FLEURS WER 6.25% against 5.74% for Whisper large-v3.
- whisper.cpp: 99 languages, slower.
- ElevenLabs Scribe v2: about 2.2% WER, but audio leaves the machine.

Electron can't do the core of it. `globalShortcut` has no keyup, so no push-to-talk, and can't bind a modifier on its own (Right ⌥, fn). Pasting into another app takes a synthetic ⌘V through `CGEventPost`. A HUD over other apps must never take focus, which a transparent `BrowserWindow` does badly.

## Decision

- A Swift helper, `treeix-voice` in `apps/desktop/native/voice`, built with SwiftPM against a pinned FluidAudio. One long-running process; it exits when stdin closes.
  - Hotkey: `NSEvent.addGlobalMonitorForEvents` on `flagsChanged` and `keyDown`, which needs Accessibility. The key is a modifier alone, told apart by its device-dependent flag. Hold to talk, a tap under 0.35s keeps listening until the next tap, Esc cancels, and another key pressed with it (⌥A for a special character) cancels too.
  - Recording: a fresh `AVAudioEngine` per dictation, converted to 16 kHz mono, so the microphone is open only while listening. Five minutes at most; too short or silent inserts nothing.
  - Speech: FluidAudio's `AsrManager` with Parakeet v3 or v2, kept loaded between dictations. Models download into the plugin's data folder.
  - Pasting: the frontmost app is remembered on key down. If it's still frontmost, the clipboard is saved, the text is set with `org.nspasteboard.TransientType` so clipboard managers skip it, ⌘V goes out with the `v` keycode of the current layout, and the clipboard comes back 0.6s later unless something else changed it. A changed app, secure input (password fields) or missing Accessibility leaves the text on the clipboard and the HUD says so.
  - HUD: SwiftUI in a non-activating `NSPanel` at the bottom of the screen under the pointer, ignoring the mouse: target app icon, level meter, state.
  - JSON lines over stdio. Main sends `configure`, `download`, `delete`, `insert`; the helper sends `ready`, `models`, `transcript`, `error`.
- One `dictation` plugin, `enabledByDefault: false`. Main-side plugins can't offer each other services, so the engine isn't split out.
  - Main spawns the helper from `app.asar.unpacked`, restarts it with backoff, and runs each transcript through the vocabulary, then the optional formatter, then sends `insert`. It keeps the last 50 dictations in `history.json`.
  - Vocabulary is a list of terms with aliases, replaced on whole words in any script.
  - Formatting goes to any OpenAI-compatible server (Ollama by default, LM Studio), 8s timeout. A reply that's empty or far off the original length is treated as an answer rather than a cleanup and the raw text is pasted.
  - Microphone and Accessibility are granted to Treeix itself, since it launches the helper from its bundle. Main checks them with `systemPreferences` and Settings links to the right pane.
- Build: `bun run build:voice` builds the helper; the release workflow runs it before packaging. The binary ships through `asarUnpack` and is signed with the inherit entitlements, which gain `com.apple.security.device.audio-input`, as does the app's. `NSMicrophoneUsageDescription` goes in `mac.extendInfo`. The MAS build leaves the helper out; its sandbox blocks the hotkey and pasting.

## Plan

1. Helper, plugin, build and signing. Enough to drop FluidVoice.
2. whisper.cpp in the same helper with ggml models from Hugging Face and a custom model URL, for languages Parakeet lacks.
3. Later, when needed: live text in the HUD (FluidAudio streaming), vocabulary boosting (CTC), file and YouTube transcription as a renderer service from this plugin, Claude as a formatter.

## Alternatives considered

- Dictation only into Treeix's own inputs, recorded with `getUserMedia`: rejected, the point is replacing FluidVoice everywhere.
- Running `fluidaudiocli` once per utterance: rejected, it reloads the model each time, and the hotkey, HUD and pasting need a native process anyway.
- Shortcuts with a letter (⌥⇧D): left out. A passive event monitor can't swallow the key, so the letter would reach the focused app.
- Copying code from FluidVoice or VoiceInk: not allowed, both are GPLv3. FluidAudio is Apache-2.0.

## Consequences

- Building the app needs Xcode's Swift toolchain; the first `build:voice` fetches FluidAudio and takes a few minutes.
- Each speech model is about 460 MB on disk and around that in memory while the plugin is on.
- In dev, macOS asks for permissions on behalf of the terminal or Electron that launched Treeix, not Treeix.app.
- The helper uses the default input device; a microphone picker can follow.
