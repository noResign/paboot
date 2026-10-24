import XCTest
import PabootProtocol

final class ScheduledTaskDtosTests: XCTestCase {
    func testDecodesScheduledTaskList() throws {
        let json = """
        {
          "tasks": [{
            "id": "t1",
            "name": "晨报",
            "type": "ai",
            "sessionMode": "existing",
            "sessionId": "s1",
            "sessionTitle": "仓库巡检",
            "workspaceId": "w1",
            "runtime": "claude",
            "prompt": "summarize",
            "permissionMode": "bypass",
            "schedule": {
              "cron": "30 9 * * 1,3,5",
              "timezone": "Asia/Shanghai",
              "preset": { "preset": "weekly", "time": "09:30", "days": [1, 3, 5] },
              "label": "每周一、周三、周五 09:30"
            },
            "nextRunAt": 1793000000000,
            "lastStatus": "never",
            "runCount": 0,
            "enabled": true,
            "createdBy": "user",
            "createdAt": 1792900000000,
            "updatedAt": 1792900000000
          }]
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(ScheduledTasksResponse.self, from: json)
        let task = try XCTUnwrap(response.tasks.first)
        XCTAssertEqual(task.name, "晨报")
        XCTAssertEqual(task.schedule.preset?.preset, "weekly")
        XCTAssertEqual(task.schedule.preset?.days, [1, 3, 5] as [Int]?)
        XCTAssertEqual(task.schedule.label, "每周一、周三、周五 09:30")
        XCTAssertTrue(task.enabled)
        XCTAssertNil(task.lastRunAt)
        XCTAssertNil(task.lastError)
    }

    func testDecodesCommandTaskDetailAndRunMetadata() throws {
        let json = """
        {
          "task": {
            "id": "t2",
            "name": "nightly",
            "type": "command",
            "sessionMode": "internal",
            "workspaceId": "w1",
            "runtime": "command",
            "command": "npm test",
            "permissionMode": "bypass",
            "schedule": { "cron": "0 */6 * * *", "timezone": "UTC", "preset": null, "label": "每 6 小时" },
            "lastStatus": "succeeded",
            "runCount": 1,
            "enabled": false,
            "disabledReason": "user",
            "createdBy": "mcp",
            "createdAt": 1792900000000,
            "updatedAt": 1792900000000
          },
          "runs": [{
            "id": "r1",
            "sessionId": "s2",
            "runtime": "command",
            "status": "succeeded",
            "prompt": "npm test",
            "startedAt": 1792900000000,
            "taskId": "t2",
            "trigger": "scheduled",
            "permissionMode": "bypass"
          }]
        }
        """.data(using: .utf8)!

        let detail = try JSONDecoder().decode(ScheduledTaskDetailResponse.self, from: json)
        XCTAssertEqual(detail.task.type, "command")
        XCTAssertEqual(detail.task.command, "npm test")
        XCTAssertEqual(detail.task.createdBy, "mcp")
        let run = try XCTUnwrap(detail.runs.first)
        XCTAssertEqual(run.trigger, "scheduled")
        XCTAssertEqual(run.taskId, "t2")
    }
}
