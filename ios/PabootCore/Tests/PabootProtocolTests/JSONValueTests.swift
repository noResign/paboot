import XCTest
@testable import PabootProtocol

final class JSONValueTests: XCTestCase {
    func testDecodesMixedObject() throws {
        let json = #"{"input_tokens":123,"text":"hi","ok":true,"nested":{"a":[1,null]}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))

        XCTAssertEqual(value["input_tokens"]?.intValue, 123)
        XCTAssertEqual(value["text"]?.stringValue, "hi")
        XCTAssertEqual(value["ok"], .bool(true))
        XCTAssertEqual(value["nested"]?["a"], .array([.number(1), .null]))
    }

    func testRoundTrips() throws {
        let value: JSONValue = .object(["a": .array([.string("x"), .number(2)])])
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, value)
    }
}
