import AppKit
import SwiftUI

enum HUDState: Equatable {
    case hidden
    case listening(handsFree: Bool)
    case transcribing
    case formatting
    case message(String)
}

@MainActor
final class HUDModel: ObservableObject {
    @Published var state = HUDState.hidden
    @Published var icon: NSImage?
    /// Recent buffer levels, newest last, for the meter
    @Published private(set) var levels = [Float](repeating: 0, count: 12)

    func push(_ level: Float) {
        levels = Array(levels.dropFirst()) + [level]
    }
}

/// A pill at the bottom of the screen under the pointer. The panel never activates or takes clicks, so focus stays in the target app.
@MainActor
final class HUD {
    let model = HUDModel()
    private var hideTimer: Timer?

    private lazy var panel: NSPanel = {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 64), styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = NSHostingView(rootView: HUDView(model: model))
        return panel
    }()

    func show(_ state: HUDState) {
        hideTimer?.invalidate()
        if case .listening = state, model.state == .hidden { model.levels.indices.forEach { _ in model.push(0) } }
        model.state = state
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let frame = screen?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.minY + 20))
        }
        panel.orderFrontRegardless()
    }

    func flash(_ text: String) {
        show(.message(text))
        hideTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { _ in MainActor.assumeIsolated { self.hide() } }
    }

    func hide() {
        hideTimer?.invalidate()
        model.state = .hidden
        model.icon = nil
        panel.orderOut(nil)
    }
}

private struct HUDView: View {
    @ObservedObject var model: HUDModel

    var body: some View {
        HStack(spacing: 8) {
            if let icon = model.icon, model.state != .hidden {
                Image(nsImage: icon).resizable().frame(width: 16, height: 16)
            }
            content
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(Capsule().fill(Color.black.opacity(0.85)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.15)))
        .opacity(model.state == .hidden ? 0 : 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .hidden: EmptyView()
        case .listening(let handsFree):
            Meter(levels: model.levels)
            Text(handsFree ? "Listening · press again to finish, Esc cancels" : "Listening")
        case .transcribing:
            ProgressView().controlSize(.small).tint(.white)
            Text("Transcribing")
        case .formatting:
            ProgressView().controlSize(.small).tint(.white)
            Text("Formatting")
        case .message(let text): Text(text)
        }
    }
}

private struct Meter: View {
    let levels: [Float]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                // Speech RMS sits around 0.01-0.1, so scale up and cap
                Capsule()
                    .fill(Color.red)
                    .frame(width: 3, height: 3 + CGFloat(min(1, levels[index] * 12)) * 15)
            }
        }
        .frame(height: 18)
        .animation(.linear(duration: 0.08), value: levels)
    }
}
