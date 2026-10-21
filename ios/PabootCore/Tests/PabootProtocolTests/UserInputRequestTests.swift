import Foundation
import XCTest
@testable import PabootProtocol

final class UserInputRequestTests: XCTestCase {
    private func request(_ json: String) throws -> UserInputRequest {
        UserInputRequest(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    func testQuestionsPreserveIDsAndRequireEveryAnswer() throws {
        let input = try request(#"{"kind":"questions","questions":[{"id":"q1","question":"Choose","options":[{"label":"A"}]},{"id":"q2","isSecret":true}]}"#)
        XCTAssertEqual(input.fields.first?.options, ["A"])
        XCTAssertEqual(input.fields.last?.secret, true)
        XCTAssertThrowsError(try input.response(values: ["q1": "A", "q2": " "]))
        XCTAssertEqual(try input.response(values: ["q1": "A", "q2": "custom"]), .object([
            "answers": .object([
                "q1": .object(["answers": .array([.string("A")])]),
                "q2": .object(["answers": .array([.string("custom")])]),
            ]),
        ]))
    }

    func testFormsEncodeTypedValuesAndOmitEmptyOptionalFields() throws {
        let input = try request(#"{"kind":"form","requestedSchema":{"properties":{"name":{"type":"string"},"count":{"type":"integer"},"enabled":{"type":"boolean"},"tags":{"type":"array"},"optional":{"type":"string"}},"required":["name"]}}"#)
        XCTAssertThrowsError(try input.response(values: [:]))
        let result = try input.response(values: [
            "name": "Ada", "count": "2", "enabled": "false", "tags": #"["A","B"]"#,
        ])
        XCTAssertEqual(result, .object([
            "name": .string("Ada"), "count": .number(2), "enabled": .bool(false),
            "tags": .array([.string("A"), .string("B")]),
        ]))
        for invalid in ["1.5", "true", "null", #""2""#] {
            XCTAssertThrowsError(try input.response(values: ["name": "Ada", "count": invalid]))
        }
        XCTAssertThrowsError(try input.response(values: ["name": "Ada", "tags": "[1] "]))
    }

    func testURLRequiresExplicitConfirmationAndUnsupportedCannotSubmit() throws {
        let url = try request(#"{"kind":"url","url":"https://example.com"}"#)
        XCTAssertTrue(url.canSubmit)
        XCTAssertEqual(try url.response(values: [:]), .null)
        let unsupported = try request(#"{"kind":"unsupported"}"#)
        XCTAssertFalse(unsupported.canSubmit)
        XCTAssertThrowsError(try unsupported.response(values: [:]))
    }
}
