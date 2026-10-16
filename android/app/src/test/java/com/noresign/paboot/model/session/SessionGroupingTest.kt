package com.noresign.paboot.model.session

import com.noresign.paboot.network.daemon.dto.SessionDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 会话列表分组：根目录平铺（近期的在上、>3 天的收进「更早」）+ 子目录按 cwd 分组
 * （docs/ui/mobile/pages/sessions.md §6.2）。
 */
class SessionGroupingTest {

    private val now = 1_700_000_000_000L
    private val day = 24L * 60 * 60 * 1000
    private val root = "/w"

    private fun session(id: String, agoMs: Long, cwd: String = root) =
        SessionDto(id = id, cwd = cwd, lastActiveAt = now - agoMs)

    @Test
    fun `root sessions split at the three day mark`() {
        val model = groupByCwd(
            listOf(
                session("recent", agoMs = day),
                session("edge", agoMs = SESSION_RECENT_WINDOW_MS),
                session("old", agoMs = SESSION_RECENT_WINDOW_MS + 1),
            ),
            workspacePath = root,
            now = now,
        )

        // 恰好三天算「近期」：判定是 >= 分界，不是 >。
        assertEquals(listOf("recent", "edge"), model.rootSessions.map { it.id })
        assertEquals(listOf("old"), model.olderRootSessions.map { it.id })
    }

    @Test
    fun `each section keeps lastActiveAt descending`() {
        val model = groupByCwd(
            listOf(
                session("old-a", agoMs = 10 * day),
                session("new-a", agoMs = day),
                session("old-b", agoMs = 4 * day),
                session("new-b", agoMs = 2 * day),
            ),
            workspacePath = root,
            now = now,
        )

        assertEquals(listOf("new-a", "new-b"), model.rootSessions.map { it.id })
        assertEquals(listOf("old-b", "old-a"), model.olderRootSessions.map { it.id })
    }

    @Test
    fun `subdirectory sessions are grouped, not folded by age`() {
        val model = groupByCwd(
            listOf(
                session("root-old", agoMs = 30 * day),
                session("sub-old", agoMs = 30 * day, cwd = "$root/pkg"),
                session("sub-new", agoMs = day, cwd = "$root/pkg"),
            ),
            workspacePath = root,
            now = now,
        )

        assertEquals(emptyList<String>(), model.rootSessions.map { it.id })
        assertEquals(listOf("root-old"), model.olderRootSessions.map { it.id })
        // 子目录分组本来就默认折叠，不受三天规则影响，两个会话仍在同一组里。
        assertEquals(1, model.subGroups.size)
        assertEquals("pkg", model.subGroups.single().displayName)
        assertEquals(listOf("sub-new", "sub-old"), model.subGroups.single().sessions.map { it.id })
    }

    @Test
    fun `without a workspace everything is grouped and nothing is folded`() {
        val model = groupByCwd(listOf(session("a", agoMs = 30 * day)), workspacePath = null, now = now)

        assertTrue(model.rootSessions.isEmpty())
        assertTrue(model.olderRootSessions.isEmpty())
        assertEquals(listOf("a"), model.subGroups.single().sessions.map { it.id })
    }
}
