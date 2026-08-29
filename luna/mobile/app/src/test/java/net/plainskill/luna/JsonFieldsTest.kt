package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JsonFieldsTest {
    @Test
    fun readsQuotedFields() {
        val json = """{"id":"u1","username":"max"}"""
        assertEquals("u1", JsonFields.string(json, "id"))
        assertEquals("max", JsonFields.string(json, "username"))
        assertNull(JsonFields.string(json, "missing"))
    }

    @Test
    fun splitsArrayObjects() {
        val objects = JsonFields.objects("""[{"id":"d1","label":"A"},{"id":"d2"}]""")
        assertEquals(2, objects.size)
        assertEquals("d1", JsonFields.string(objects[0], "id"))
        assertEquals("d2", JsonFields.string(objects[1], "id"))
    }
}
