import EventKit

struct CalendarEvent {
    let title: String
    let start: Date
    let end: Date
    /// The first link in the event's URL, location or notes: where calendars put the call link
    let url: String?
    /// URL, location and notes joined, to find a call's link anywhere in them
    let links: String
    let invitees: [String]

    var json: [String: Any] { ["title": title, "start": isoString(start), "end": isoString(end), "url": url ?? NSNull(), "invitees": invitees] }
}

private let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

/// A call link without scheme, query or trailing slash, as event notes write it
private func linkKey(_ url: String) -> String? {
    guard let components = URLComponents(string: url), let host = components.host else { return nil }
    let path = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    return host + path
}

/// The macOS Calendar store, which syncs Google and other accounts added in System Settings
final class MeetingCalendar {
    private let store = EKEventStore()

    private var status: String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: "granted"
        case .notDetermined: "not-determined"
        case .restricted: "restricted"
        default: "denied"
        }
    }

    func requestAccess(_ done: @escaping (String) -> Void) {
        guard EKEventStore.authorizationStatus(for: .event) == .notDetermined else { return done(status) }
        store.requestFullAccessToEvents { _, _ in DispatchQueue.main.async { done(self.status) } }
    }

    func events(from: Date, to: Date) -> [CalendarEvent] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess, from < to else { return [] }
        return store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
            .filter { !$0.isAllDay }
            .sorted { $0.startDate < $1.startDate }
            .map { event in
                let links = [event.url?.absoluteString, event.location, event.notes].compactMap { $0 }.joined(separator: "\n")
                let url = linkDetector?.firstMatch(in: links, range: NSRange(links.startIndex..., in: links))?.url?.absoluteString
                return CalendarEvent(
                    title: event.title ?? "", start: event.startDate, end: event.endDate, url: url, links: links,
                    invitees: (event.attendees ?? [])
                        .filter { ![.room, .resource].contains($0.participantType) && $0.participantStatus != .declined && !$0.isCurrentUser }
                        .map { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") })
            }
    }

    /// The event carrying the call's link, else one with invitees under way (or starting within 10 minutes) at `at`
    func event(at: Date, url: String?) -> CalendarEvent? {
        let nearby = events(from: at.addingTimeInterval(-3 * 3600), to: at.addingTimeInterval(3 * 3600))
        let nearest = { (events: [CalendarEvent]) in events.min { abs($0.start.timeIntervalSince(at)) < abs($1.start.timeIntervalSince(at)) } }
        if let key = url.flatMap(linkKey), let linked = nearest(nearby.filter { $0.links.contains(key) }) { return linked }
        return nearest(nearby.filter { !$0.invitees.isEmpty && $0.start <= at.addingTimeInterval(10 * 60) && at < $0.end })
    }
}
