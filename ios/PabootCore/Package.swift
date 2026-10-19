// swift-tools-version: 5.9
import PackageDescription

/// Two targets on purpose:
///
/// - `PabootProtocol` is pure Foundation (DTOs, SSE parsing, reconnect policy) and can be
///   built and tested without UIKit. Keep it free of `URLSession` transport so it stays
///   portable.
/// - `PabootClient` is the Darwin transport (URLSession + SSE) and depends on the protocol
///   layer. The app target imports only these two modules — never `Foundation` JSON by hand.
let package = Package(
    name: "PabootCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "PabootCore", targets: ["PabootProtocol", "PabootClient"]),
    ],
    targets: [
        .target(name: "PabootProtocol"),
        .target(name: "PabootClient", dependencies: ["PabootProtocol"]),
        .testTarget(name: "PabootProtocolTests", dependencies: ["PabootProtocol"]),
    ]
)
