package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingQrTest {
    @Test
    fun roundTripsAddressAndToken() {
        val encoded = PairingQr.encode("http://luna.local/", "tok-abc")
        assertEquals("luna://pair?url=http%3A%2F%2Fluna.local&token=tok-abc", encoded)
        assertEquals(Pairing("http://luna.local", "tok-abc"), PairingQr.decode(encoded))
    }

    @Test
    fun encodesReservedCharacters() {
        val encoded = PairingQr.encode("http://192.168.1.20:8090", "a+b/c=&x")
        assertEquals(Pairing("http://192.168.1.20:8090", "a+b/c=&x"), PairingQr.decode(encoded))
    }

    @Test
    fun acceptsJsonPayload() {
        val parsed = PairingQr.decode("""{"url":"http://luna.local/","token":"xyz"}""")
        assertEquals(Pairing("http://luna.local", "xyz"), parsed)
    }

    @Test
    fun rejectsIncompleteOrForeignPayloads() {
        assertNull(PairingQr.decode("https://example.com"))
        assertNull(PairingQr.decode("luna://pair?url=http://luna.local"))
        assertNull(PairingQr.decode("luna://other?url=http://luna.local&token=x"))
        assertNull(PairingQr.decode(""))
        assertNull(PairingQr.decode(null))
    }
}
