import XCTest
@testable import PabootProtocol

final class URLNormalizerTests: XCTestCase {
    func testAddsDefaultScheme() {
        XCTAssertEqual(
            URLNormalizer.normalize("192.168.1.2:4780")?.absoluteString,
            "http://192.168.1.2:4780"
        )
    }

    func testStripsTrailingSlash() {
        XCTAssertEqual(
            URLNormalizer.normalize("http://host:4780/")?.absoluteString,
            "http://host:4780"
        )
    }

    func testKeepsExplicitHTTPS() {
        XCTAssertEqual(
            URLNormalizer.normalize("https://example.com")?.absoluteString,
            "https://example.com"
        )
    }

    func testRejectsEmptyAndHostlessInput() {
        XCTAssertNil(URLNormalizer.normalize("   "))
        XCTAssertNil(URLNormalizer.normalize("http://"))
    }
}
