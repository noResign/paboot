import Foundation

/// Path presentation helpers shared by the file list, diff and viewer screens.
enum FilePathDisplay {
    static func fileName(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }

    /// Directory prefix with only the last `maxDepth` components; deeper paths start with `…/`.
    /// Keeping the tail matters because leading levels repeat on every row.
    static func directoryPrefix(_ path: String, maxDepth: Int = 3) -> String? {
        let directory = (path as NSString).deletingLastPathComponent
        guard !directory.isEmpty else { return nil }

        let parts = directory.split(separator: "/")
        guard !parts.isEmpty else { return nil }

        if parts.count <= maxDepth {
            return parts.joined(separator: "/")
        }
        return "…/" + parts.suffix(maxDepth).joined(separator: "/")
    }

    static func byteSize(_ value: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: value)
    }
}
