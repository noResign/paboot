package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduledTaskDtosTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `decodes an AI task with a structured preset`() {
        val payload = """
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
        """.trimIndent()

        val response = json.decodeFromString(ScheduledTasksResponse.serializer(), payload)
        val task = response.tasks.single()
        assertEquals("晨报", task.name)
        assertEquals("weekly", task.schedule.preset?.preset)
        assertEquals(listOf(1, 3, 5), task.schedule.preset?.days)
        assertEquals("每周一、周三、周五 09:30", task.schedule.label)
        assertTrue(task.enabled)
        assertNull(task.lastRunAt)
        assertNull(task.lastError)
    }

    @Test
    fun `decodes a command task and run metadata`() {
        val payload = """
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
                "schedule": { "cron": "0 */6 * * *", "timezone": "UTC", "label": "每 6 小时" },
                "lastStatus": "succeeded",
                "enabled": false,
                "disabledReason": "user",
                "createdBy": "mcp"
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
        """.trimIndent()

        val detail = json.decodeFromString(ScheduledTaskDetailResponse.serializer(), payload)
        assertEquals("command", detail.task.type)
        assertEquals("npm test", detail.task.command)
        assertEquals("mcp", detail.task.createdBy)
        assertEquals("scheduled", detail.runs.single().trigger)
        assertEquals("t2", detail.runs.single().taskId)
    }
}
