import AppKit
import Carbon

enum InsertMethod { case paste, clipboard }

/// Pastes into the app that was in front when dictation started, then puts the clipboard back
@MainActor
enum Inserter {
    /// Clipboard managers skip items marked this way (nspasteboard.org)
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    static func insert(_ text: String, into target: NSRunningApplication?) -> InsertMethod {
        let pasteboard = NSPasteboard.general
        // Focus moved on, or a password field holds secure input: pasting could land somewhere unintended
        let canPaste =
            AXIsProcessTrusted() && !IsSecureEventInputEnabled() && target != nil
            && NSWorkspace.shared.frontmostApplication?.processIdentifier == target?.processIdentifier
        guard canPaste else {
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            return .clipboard
        }
        let saved = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        pasteboard.setData(Data(), forType: transient)
        let ours = pasteboard.changeCount
        pressPaste()
        // The target reads the clipboard after it handles ⌘V, so restoring right away would paste the old contents
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard pasteboard.changeCount == ours, !saved.isEmpty else { return }
            pasteboard.clearContents()
            pasteboard.writeObjects(
                saved.map { entries in
                    let item = NSPasteboardItem()
                    for (type, data) in entries { item.setData(data, forType: type) }
                    return item
                })
        }
        return .paste
    }

    private static func pressPaste() {
        let key = keyCode(for: "v")
        // A private source ignores keys still physically held, such as the hotkey, so this is ⌘V and not ⌥⌘V
        let source = CGEventSource(stateID: .privateState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
            event?.flags = .maskCommand
            event?.post(tap: .cghidEventTap)
        }
    }

    /// The key that types `character` on the ASCII layout shortcuts use, so ⌘V works on Dvorak; ANSI V otherwise
    private static func keyCode(for character: Character) -> CGKeyCode {
        let ansiV: CGKeyCode = 9
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
            let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return ansiV }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        let wanted = character.utf16.first
        return data.withUnsafeBytes { bytes in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return ansiV }
            for code in 0..<128 {
                var deadKeys: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
                if status == noErr, length == 1, chars[0] == wanted { return CGKeyCode(code) }
            }
            return ansiV
        }
    }
}
