// swift-tools-version: 5.9
import PackageDescription

/// Three targets on purpose:
///
/// - `PabootProtocol` is pure Foundation (DTOs, SSE parsing, reconnect policy) and can be
///   built and tested without UIKit. Keep it free of `URLSession` transport so it stays
///   portable.
/// - `PabootClient` is the Darwin transport (URLSession + SSE) and depends on the protocol
///   layer.
/// - `PabootMarkdownUI` parses with `swift-markdown` and renders UIKit block views. Its
///   source is guarded by `#if canImport(UIKit)`, so Linux/macOS package builds see an
///   empty target while the iOS app gets the renderer.
let package = Package(
    name: "PabootCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "PabootCore",
            targets: ["PabootProtocol", "PabootClient", "PabootMarkdownUI"]
        ),
    ],
    dependencies: [
        // 0.8+ requires Swift tools 6.2; 0.7.x keeps the package buildable with
        // the Swift 5.9/Xcode 15+ toolchain this project targets.
        .package(
            url: "https://github.com/swiftlang/swift-markdown.git",
            .upToNextMinor(from: "0.7.0")
        ),
    ],
    targets: [
        .target(name: "PabootProtocol"),
        .target(name: "PabootClient", dependencies: ["PabootProtocol"]),
        .target(
            name: "PabootMarkdownUI",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown"),
            ]
        ),
        .testTarget(name: "PabootProtocolTests", dependencies: ["PabootProtocol"]),
        .testTarget(name: "PabootClientTests", dependencies: ["PabootClient", "PabootProtocol"]),
    ]
)
