import Foundation

/// Turns what a user typed into a base URL the API layer can append paths to.
///
/// Accepted forms: `192.168.1.2:4780`, `http://host:4780`, `https://host/` (trailing
/// slashes are stripped). The scheme defaults to `http`, matching the daemon's default.
public enum URLNormalizer {
    public static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard var components = URLComponents(string: withScheme) else { return nil }
        guard let host = components.host, !host.isEmpty else { return nil }

        var path = components.path
        if path == "/" {
            path = ""
        }
        while path.hasSuffix("/") {
            path.removeLast()
        }
        components.path = path
        return components.url
    }
}
