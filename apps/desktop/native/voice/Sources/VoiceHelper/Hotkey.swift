import AppKit
import ApplicationServices

/// Modifier keys by the renderer's `KeyboardEvent.code`; `mask` is the device-dependent bit, which tells right ⌥ from left ⌥
private let modifierKeys: [String: (mask: UInt, flag: NSEvent.ModifierFlags)] = [
    "ControlLeft": (0x01, .control), "ShiftLeft": (0x02, .shift), "ShiftRight": (0x04, .shift),
    "MetaLeft": (0x08, .command), "MetaRight": (0x10, .command), "AltLeft": (0x20, .option),
    "AltRight": (0x40, .option), "ControlRight": (0x2000, .control), "Fn": (NSEvent.ModifierFlags.function.rawValue, .function),
]

/// Modifiers held together on their own
struct HotkeyChord {
    let mask: UInt
    let flags: NSEvent.ModifierFlags

    init(_ codes: [String]) {
        let keys = codes.compactMap { modifierKeys[$0] }
        mask = keys.reduce(0) { $0 | $1.mask }
        flags = keys.reduce([]) { $0.union($1.flag) }
    }
}

/// Watches the keyboard in every app. Monitoring other apps' keys needs Accessibility, so it starts once that is granted.
/// A global monitor only listens: the keys still reach the app in front, which is why the hotkey is modifiers only.
@MainActor
final class Hotkey {
    var chord = HotkeyChord(["MetaLeft", "AltRight"]) {
        didSet { held = false }
    }
    var onPress: (@MainActor () -> Void)?
    var onRelease: (@MainActor () -> Void)?
    var onOtherKey: (@MainActor () -> Void)?
    var onEscape: (@MainActor () -> Void)?

    private var held = false
    private var monitor: Any?
    private var retry: Timer?

    init() {
        install()
    }

    private func install() {
        guard AXIsProcessTrusted() else {
            // Granting Accessibility doesn't notify anyone, and a monitor added before it never receives events
            retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { _ in MainActor.assumeIsolated { self.install() } }
            return
        }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
            MainActor.assumeIsolated { self.handle(event) }
        }
    }

    private func handle(_ event: NSEvent) {
        if event.type == .keyDown {
            // Our own ⌘V, typing a piece of the dictation while the keys are held
            if event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid()) { return }
            if event.keyCode == 53 { onEscape?() } else if held { onOtherKey?() }
            return
        }
        // Another modifier joined in, e.g. right ⌥ then ⇧ for a shortcut
        if held, !event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(chord.flags.union(.capsLock)).isEmpty {
            onOtherKey?()
            return
        }
        let down = chord.mask != 0 && event.modifierFlags.rawValue & chord.mask == chord.mask
        guard down != held else { return }
        held = down
        if down { onPress?() } else { onRelease?() }
    }
}
