import AppKit
import ApplicationServices

/// A modifier held on its own; `mask` is its device-dependent bit, which tells right ⌥ from left ⌥
enum HotkeyKey: String {
    case rightOption, rightCommand, rightControl, rightShift, fn

    var keyCode: UInt16 {
        switch self {
        case .rightOption: 61
        case .rightCommand: 54
        case .rightControl: 62
        case .rightShift: 60
        case .fn: 63
        }
    }

    var flag: NSEvent.ModifierFlags {
        switch self {
        case .rightOption: .option
        case .rightCommand: .command
        case .rightControl: .control
        case .rightShift: .shift
        case .fn: .function
        }
    }

    var mask: UInt {
        switch self {
        case .rightOption: 0x40
        case .rightCommand: 0x10
        case .rightControl: 0x2000
        case .rightShift: 0x04
        case .fn: NSEvent.ModifierFlags.function.rawValue
        }
    }
}

/// Watches the keyboard in every app. Monitoring other apps' keys needs Accessibility, so it starts once that is granted.
/// A global monitor only listens: the key still reaches the app in front, which is why the hotkey is a lone modifier.
@MainActor
final class Hotkey {
    var key = HotkeyKey.rightOption {
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
            if event.keyCode == 53 { onEscape?() } else if held { onOtherKey?() }
            return
        }
        guard event.keyCode == key.keyCode else {
            // Another modifier joined in, e.g. right ⌥ then ⇧ for a shortcut
            if held, !event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([key.flag, .capsLock]).isEmpty { onOtherKey?() }
            return
        }
        let down = event.modifierFlags.rawValue & key.mask != 0
        guard down != held else { return }
        held = down
        if down { onPress?() } else { onRelease?() }
    }
}
