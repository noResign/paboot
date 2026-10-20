import Foundation
import XCTest
@testable import PabootProtocol

final class EventDtosTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testSSEFrameDecodesRunMetadataAndEventTogether() throws {
        let frame = try decode(
            SSEFrame.self,
            #"{"runId":"r1","seq":7,"event":{"type":"text_delta","delta":"你好"}}"#
        )

        XCTAssertEqual(frame.runId, "r1")
        XCTAssertEqual(frame.seq, 7)
        guard case .textDelta(let event) = frame.event else {
            return XCTFail("expected textDelta")
        }
        XCTAssertEqual(event.delta, "你好")
    }

    func testEveryNormalizedEventVariantDecodesFromItsTypeTag() throws {
        let cases: [(String, (NormalizedEvent) -> Bool)] = [
            (#"{"type":"status","label":"running"}"#, { event in
                guard case .status(let value) = event else { return false }
                return value.label == "running"
            }),
            (#"{"type":"text_delta","delta":"a"}"#, { event in
                guard case .textDelta(let value) = event else { return false }
                return value.delta == "a"
            }),
            (#"{"type":"thinking_delta","delta":"a"}"#, { event in
                guard case .thinkingDelta(let value) = event else { return false }
                return value.delta == "a"
            }),
            (#"{"type":"thinking_start"}"#, { event in
                guard case .thinkingStart = event else { return false }
                return true
            }),
            (#"{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}"#, { event in
                guard case .toolUse(let value) = event else { return false }
                return value.id == "t1" && value.name == "Bash" && value.input?["command"]?.stringValue == "ls"
            }),
            (#"{"type":"tool_result","content":"ok"}"#, { event in
                guard case .toolResult(let value) = event else { return false }
                return value.content == "ok"
            }),
            (#"{"type":"usage","costUsd":0.01}"#, { event in
                guard case .usage(let value) = event else { return false }
                return value.costUsd == 0.01
            }),
            (#"{"type":"turn_end","stopReason":"end_turn"}"#, { event in
                guard case .turnEnd(let value) = event else { return false }
                return value.stopReason == "end_turn"
            }),
            (#"{"type":"error","message":"boom"}"#, { event in
                guard case .error(let value) = event else { return false }
                return value.message == "boom"
            }),
            (#"{"type":"permission_request","permissionId":"p1","toolName":"Bash"}"#, { event in
                guard case .permissionRequest(let value) = event else { return false }
                return value.permissionId == "p1" && value.toolName == "Bash"
            }),
            (
                #"{"type":"question","toolUseId":"q1","questions":[{"question":"What?","header":"H","multiSelect":false,"options":[{"label":"A","description":"d"}]}]}"#,
                { event in
                    guard case .question(let value) = event else { return false }
                    guard let question = value.questions.first else { return false }
                    return value.toolUseId == "q1"
                        && question.question == "What?"
                        && question.options.first?.label == "A"
                }
            ),
        ]

        for (json, matches) in cases {
            let event = try decode(NormalizedEvent.self, json)
            XCTAssertTrue(matches(event), "failed to decode \(json)")
        }
    }

    func testUnknownEventTypeDecodesToUnknown() throws {
        let event = try decode(NormalizedEvent.self, #"{"type":"future_event","payload":1}"#)
        guard case .unknown(let type) = event else {
            return XCTFail("expected unknown")
        }
        XCTAssertEqual(type, "future_event")
    }

    func testUsageDecodesContextOccupancyAndLegacyFramesLeaveItUnset() throws {
        let withContext = try decode(
            NormalizedEvent.self,
            #"{"type":"usage","usage":null,"contextTokens":45200,"contextWindow":168000}"#
        )
        guard case .usage(let usage) = withContext else {
            return XCTFail("expected usage")
        }
        XCTAssertEqual(usage.contextTokens, 45_200)
        XCTAssertEqual(usage.contextWindow, 168_000)

        let noWindow = try decode(
            NormalizedEvent.self,
            #"{"type":"usage","contextTokens":5300,"contextWindow":null}"#
        )
        guard case .usage(let partial) = noWindow else {
            return XCTFail("expected usage")
        }
        XCTAssertEqual(partial.contextTokens, 5_300)
        XCTAssertNil(partial.contextWindow)

        let legacy = try decode(NormalizedEvent.self, #"{"type":"usage","costUsd":0.01}"#)
        guard case .usage(let old) = legacy else {
            return XCTFail("expected usage")
        }
        XCTAssertNil(old.contextTokens)
        XCTAssertNil(old.contextWindow)
    }

    func testUnknownFieldsOnAKnownEventAreTolerated() throws {
        let event = try decode(
            NormalizedEvent.self,
            #"{"type":"tool_result","content":"ok","somethingNew":123}"#
        )
        guard case .toolResult(let value) = event else {
            return XCTFail("expected toolResult")
        }
        XCTAssertEqual(value.content, "ok")
    }

    func testChatRequestOmitsUnsetOptionalFields() throws {
        let data = try JSONEncoder().encode(ChatRequest(prompt: "hi"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(body["prompt"] as? String, "hi")
        XCTAssertNil(body["sessionId"])
        XCTAssertNil(body["runtime"])
        XCTAssertNil(body["commandId"])
    }

    func testChatRequestEncodesProvidedOptions() throws {
        let data = try JSONEncoder().encode(
            ChatRequest(
                prompt: "hi",
                workspaceId: "w1",
                model: "m",
                modelParameters: ["reasoningEffort": "high"],
                runtime: "codex",
                commandId: "c1"
            )
        )
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(body["workspaceId"] as? String, "w1")
        XCTAssertEqual(body["model"] as? String, "m")
        XCTAssertEqual(body["runtime"] as? String, "codex")
        XCTAssertEqual(body["commandId"] as? String, "c1")
        XCTAssertEqual((body["modelParameters"] as? [String: String])?["reasoningEffort"], "high")
    }

    func testUpdateSessionModelRequestEncodesNilAsNull() throws {
        let data = try JSONEncoder().encode(
            UpdateSessionModelRequest(model: nil, modelParameters: nil)
        )
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertTrue(body.keys.contains("model"))
        XCTAssertTrue(body.keys.contains("modelParameters"))
        XCTAssertNotNil(body["model"] as? NSNull)
        XCTAssertNotNil(body["modelParameters"] as? NSNull)
    }
}
