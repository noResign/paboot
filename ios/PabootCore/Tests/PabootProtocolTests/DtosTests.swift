import Foundation
import XCTest
@testable import PabootProtocol

final class DtosTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testSessionDetailDecodesSnakeCaseMessagesAndCheckpoint() throws {
        let json = """
        {
          "session": {
            "id": "s1",
            "runtime": "claude",
            "workspaceId": "w1",
            "permissionMode": "ask",
            "model": null,
            "modelParameters": {"reasoningEffort": "high"},
            "cwd": "/work",
            "title": "hello",
            "createdAt": 1,
            "lastActiveAt": 2,
            "running": false,
            "runningRunId": null
          },
          "messages": [
            {"id": 1, "session_id": "s1", "role": "user", "content": "hi", "created_at": 3}
          ],
          "runs": [
            {
              "id": "r1",
              "sessionId": "s1",
              "runtime": "claude",
              "model": null,
              "modelParameters": null,
              "status": "succeeded",
              "prompt": "hi",
              "startedAt": 1,
              "endedAt": 2,
              "exitCode": 0,
              "error": null,
              "checkpoint": {
                "status": "complete",
                "repoRoot": "/work",
                "preRef": "abc",
                "postRef": "def"
              }
            }
          ]
        }
        """

        let detail = try decode(SessionDetailResponse.self, json)

        XCTAssertEqual(detail.session.id, "s1")
        XCTAssertEqual(detail.session.modelParameters?["reasoningEffort"], "high")
        XCTAssertEqual(detail.messages.first?.sessionId, "s1")
        XCTAssertEqual(detail.messages.first?.createdAt, 3)
        XCTAssertEqual(detail.runs.first?.checkpoint?.preRef, "abc")
        XCTAssertEqual(detail.runs.first?.checkpoint?.postRef, "def")
    }

    func testSessionDefaultsAreAppliedWhenFieldsAreMissing() throws {
        let session = try decode(SessionDto.self, #"{"id":"s1"}"#)

        XCTAssertEqual(session.runtime, "")
        XCTAssertEqual(session.permissionMode, "ask")
        XCTAssertEqual(session.cwd, "")
        XCTAssertFalse(session.running)
        XCTAssertNil(session.title)
        XCTAssertNil(session.runningRunId)
    }

    func testAgentAvailabilityDefaultsToTrueWhenFieldIsMissing() throws {
        let agent = try decode(AgentDto.self, #"{"id":"claude","name":"Claude Code","bin":"claude"}"#)
        XCTAssertTrue(agent.available)
    }

    func testWorkspaceDecodesListsAndFlags() throws {
        let workspace = try decode(
            WorkspaceDto.self,
            #"{"id":"w1","name":"repo","path":"/repo","dirs":["/shared"],"shortcutDirs":["/tmp"],"isDefault":true,"enabled":true,"sessionCount":3,"createdAt":1,"lastUsedAt":2}"#
        )

        XCTAssertEqual(workspace.id, "w1")
        XCTAssertEqual(workspace.dirs, ["/shared"])
        XCTAssertEqual(workspace.shortcutDirs, ["/tmp"])
        XCTAssertTrue(workspace.isDefault)
        XCTAssertEqual(workspace.sessionCount, 3)
    }

    func testConfigDecodesServerBlock() throws {
        let config = try decode(
            ConfigResponse.self,
            #"{"defaultPermissionMode":"acceptEdits","defaultWorkspaceId":"w1","workspaces":[],"server":{"host":"127.0.0.1","port":4780,"dataDir":"/home/u/.paboot","tls":false,"restartRequired":[]}}"#
        )

        XCTAssertEqual(config.defaultPermissionMode, "acceptEdits")
        XCTAssertEqual(config.defaultWorkspaceId, "w1")
        XCTAssertEqual(config.server?.port, 4780)
        XCTAssertFalse(config.server?.tls ?? true)
    }

    func testModelCatalogDecodesParameters() throws {
        let response = try decode(
            AgentModelsResponse.self,
            #"{"models":[{"id":"m1","label":"Model 1","parameters":[{"id":"reasoningEffort","label":"推理强度","values":[{"id":"low","label":"低"}],"defaultId":"low"}]}]}"#
        )

        let model = try XCTUnwrap(response.models.first)
        XCTAssertEqual(model.parameters.first?.id, "reasoningEffort")
        XCTAssertEqual(model.parameters.first?.values.first?.label, "低")
        XCTAssertEqual(model.parameters.first?.defaultId, "low")
    }
}
