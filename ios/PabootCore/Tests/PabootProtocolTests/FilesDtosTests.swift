import Foundation
import XCTest
@testable import PabootProtocol

final class FilesDtosTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testFilesResponseDecodesRootsAndEntries() throws {
        let json = """
        {
          "workspaceId": "w1",
          "workspacePath": "/work",
          "root": "/work",
          "roots": ["/work", "/shared"],
          "shortcutDirs": ["/tmp/notes"],
          "path": "src",
          "parent": "",
          "entries": [
            {"name": "auth", "path": "src/auth", "type": "directory", "size": null, "modifiedAt": 1700000000000},
            {"name": "main.ts", "path": "src/main.ts", "type": "file", "size": 2048, "modifiedAt": 1700000001000}
          ],
          "nextCursor": "200"
        }
        """

        let response = try decode(FilesResponse.self, json)

        XCTAssertEqual(response.root, "/work")
        XCTAssertEqual(response.roots, ["/work", "/shared"])
        XCTAssertEqual(response.shortcutDirs, ["/tmp/notes"])
        XCTAssertEqual(response.parent, "")
        XCTAssertEqual(response.entries.first?.type, "directory")
        XCTAssertEqual(response.entries.last?.size, 2048)
        XCTAssertEqual(response.nextCursor, "200")
    }

    func testFilesResponseFallsBackForMissingOptionalFields() throws {
        let response = try decode(
            FilesResponse.self,
            """
            {"workspaceId": "w1", "path": "", "entries": [{"name": "a.txt", "path": "a.txt"}]}
            """
        )

        XCTAssertEqual(response.entries.first?.type, "file")
        XCTAssertNil(response.entries.first?.size)
        XCTAssertTrue(response.roots.isEmpty)
        XCTAssertNil(response.parent)
    }

    func testChangesResponseDecodesStatusAndStats() throws {
        let json = """
        {
          "workspaceId": "w1",
          "workspacePath": "/work",
          "root": "/work",
          "roots": ["/work"],
          "shortcutDirs": [],
          "isGitRepo": true,
          "gitRoot": "/work",
          "repos": [],
          "files": [
            {"path": "src/a.ts", "status": "modified", "staged": true, "binary": false,
             "isDirectory": false, "additions": 18, "deletions": 4},
            {"path": "logo.png", "status": "untracked", "binary": true, "isDirectory": false,
             "oldPath": null, "staged": false}
          ]
        }
        """

        let response = try decode(ChangesResponse.self, json)

        XCTAssertTrue(response.isGitRepo)
        XCTAssertEqual(response.gitRoot, "/work")
        XCTAssertEqual(response.files.count, 2)
        XCTAssertEqual(response.files[0].status, "modified")
        XCTAssertTrue(response.files[0].staged)
        XCTAssertEqual(response.files[0].additions, 18)
        XCTAssertTrue(response.files[1].binary)
        XCTAssertNil(response.files[1].additions)
    }

    func testChangesResponseDecodesChildReposWhenNotAGitRepo() throws {
        let response = try decode(
            ChangesResponse.self,
            """
            {
              "workspaceId": "w1", "workspacePath": "/work", "root": "/work",
              "roots": ["/work"], "isGitRepo": false, "gitRoot": null,
              "repos": ["repoA", "repoB"], "files": []
            }
            """
        )

        XCTAssertFalse(response.isGitRepo)
        XCTAssertEqual(response.repos, ["repoA", "repoB"])
    }

    func testDiffResponseDecodesPatchFlags() throws {
        let json = """
        {
          "root": "/work",
          "path": "src/a.ts",
          "oldPath": "src/old.ts",
          "status": "renamed",
          "binary": false,
          "truncated": true,
          "patch": "@@ -1 +1 @@\\n-old\\n+new\\n"
        }
        """

        let diff = try decode(DiffResponse.self, json)

        XCTAssertEqual(diff.status, "renamed")
        XCTAssertEqual(diff.oldPath, "src/old.ts")
        XCTAssertTrue(diff.truncated)
        XCTAssertTrue(diff.patch.contains("+new"))
    }

    func testFileContentDecodesBinaryAndTruncation() throws {
        let content = try decode(
            FileContentDto.self,
            """
            {"root": "/work", "path": "a.bin", "size": 2097152, "binary": true, "truncated": true, "content": ""}
            """
        )

        XCTAssertTrue(content.binary)
        XCTAssertTrue(content.truncated)
        XCTAssertEqual(content.size, 2097152)
    }
}
