package net.plainskill.luna

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateLanTest {
    @Test
    fun rfc1918AndLoopbackAndLinkLocal() {
        assertTrue(PrivateLan.allowsCleartext("10.0.0.1"))
        assertTrue(PrivateLan.allowsCleartext("10.42.0.1"))
        assertTrue(PrivateLan.allowsCleartext("192.168.1.20"))
        assertTrue(PrivateLan.allowsCleartext("172.16.0.2"))
        assertTrue(PrivateLan.allowsCleartext("172.31.255.1"))
        assertTrue(PrivateLan.allowsCleartext("127.0.0.1"))
        assertTrue(PrivateLan.allowsCleartext("169.254.1.1"))
        assertTrue(PrivateLan.allowsCleartext("luna.local"))
        assertTrue(PrivateLan.allowsCleartext("localhost"))
        assertFalse(PrivateLan.allowsCleartext("8.8.8.8"))
        assertFalse(PrivateLan.allowsCleartext("example.com"))
        assertFalse(PrivateLan.allowsCleartext("172.32.0.1"))
    }
}
