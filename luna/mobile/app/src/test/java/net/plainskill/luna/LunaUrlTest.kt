package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LunaUrlTest {
    @Test
    fun placeholderConstant() {
        assertEquals("kitchen.luna.servers.libreloom.org", LunaUrl.ADDRESS_PLACEHOLDER)
    }

    @Test
    fun emptyAndWhitespace() {
        assertNull(LunaUrl.normalize(""))
        assertNull(LunaUrl.normalize("   "))
        assertNull(LunaUrl.normalize("\t\n"))
    }

    @Test
    fun trimsAndStripsPathQueryFragment() {
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("  https://Kitchen.luna.servers.libreloom.org/setup?x=1#y  "),
        )
        assertEquals("http://luna.local", LunaUrl.normalize("http://luna.local/"))
        assertEquals("http://luna.local", LunaUrl.normalize("http://luna.local///files/"))
    }

    @Test
    fun addsHttpsForPublicHosts() {
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("kitchen.luna.servers.libreloom.org"),
        )
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("KITCHEN.LUNA.SERVERS.LIBRELOOM.ORG"),
        )
    }

    @Test
    fun addsHttpForLanAndLoopback() {
        assertEquals("http://localhost", LunaUrl.normalize("localhost"))
        assertEquals("http://localhost:8090", LunaUrl.normalize("localhost:8090"))
        assertEquals("http://127.0.0.1", LunaUrl.normalize("127.0.0.1"))
        assertEquals("http://127.0.0.1:8090", LunaUrl.normalize("127.0.0.1:8090"))
        assertEquals("http://luna.local", LunaUrl.normalize("luna.local"))
        assertEquals("http://192.168.1.20:8090", LunaUrl.normalize("192.168.1.20:8090"))
        assertEquals("http://10.0.0.5", LunaUrl.normalize("10.0.0.5"))
        assertEquals("http://172.16.0.2", LunaUrl.normalize("172.16.0.2"))
        assertEquals("http://nas.lan", LunaUrl.normalize("nas.lan"))
    }

    @Test
    fun keepsExplicitScheme() {
        assertEquals(
            "http://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("http://kitchen.luna.servers.libreloom.org"),
        )
        assertEquals(
            "https://192.168.1.20:8090",
            LunaUrl.normalize("https://192.168.1.20:8090"),
        )
    }

    @Test
    fun repairsSchemeTypos() {
        assertEquals("http://luna.local", LunaUrl.normalize("HTTP://Luna.Local"))
        assertEquals("http://luna.local", LunaUrl.normalize("http:/luna.local"))
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("https:/kitchen.luna.servers.libreloom.org"),
        )
        assertEquals("http://127.0.0.1:8090", LunaUrl.normalize("http//127.0.0.1:8090"))
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("https//kitchen.luna.servers.libreloom.org"),
        )
        assertEquals("http://192.168.1.20:8090", LunaUrl.normalize("http:192.168.1.20:8090"))
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("https:kitchen.luna.servers.libreloom.org"),
        )
    }

    @Test
    fun collapsesSpacesInPaste() {
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("https:// kitchen.luna.servers.libreloom.org "),
        )
        assertEquals(
            "https://kitchen.luna.servers.libreloom.org",
            LunaUrl.normalize("kitchen . luna . servers . libreloom . org"),
        )
    }

    @Test
    fun ipv6Loopback() {
        assertEquals("http://[::1]", LunaUrl.normalize("[::1]"))
        assertEquals("http://[::1]:8090", LunaUrl.normalize("[::1]:8090"))
        assertEquals("http://[::1]:8090", LunaUrl.normalize("http://[::1]:8090/"))
    }

    @Test
    fun publicIpDefaultsToHttps() {
        assertEquals("https://8.8.8.8", LunaUrl.normalize("8.8.8.8"))
    }

    @Test
    fun rejectsGarbage() {
        assertNull(LunaUrl.normalize(":///"))
        assertNull(LunaUrl.normalize("http://"))
        assertNull(LunaUrl.normalize("http://host:99999"))
    }
}
