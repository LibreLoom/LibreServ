package net.plainskill.luna

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingDecisionTest {
    private val pairing = Pairing("http://luna.local", "tok")

    @Test
    fun aSignedOutPhoneAlwaysAsksBeforeFilling() {
        assertEquals(
            PairingChoice.CONFIRM_FILL,
            PairingDecision.choose(signedIn = false, currentUrl = null, pairing = pairing)
        )
        // Even when the fields (or a saved address) already hold another Luna,
        // the link must still ask and name the address it wants to fill in.
        assertEquals(
            PairingChoice.CONFIRM_FILL,
            PairingDecision.choose(false, "http://other.local", pairing)
        )
        assertEquals(
            PairingChoice.CONFIRM_FILL,
            PairingDecision.choose(false, "http://luna.local", pairing)
        )
    }

    @Test
    fun aSignedInPhoneAlreadyOnThatLunaNeedsNoChange() {
        assertEquals(
            PairingChoice.ALREADY_CONNECTED,
            PairingDecision.choose(true, "http://luna.local", pairing)
        )
        assertEquals(
            PairingChoice.ALREADY_CONNECTED,
            PairingDecision.choose(true, "HTTP://LUNA.LOCAL", pairing)
        )
    }

    @Test
    fun aSignedInPhoneOnAnotherLunaConfirmsTheSwitch() {
        assertEquals(
            PairingChoice.CONFIRM_SWITCH,
            PairingDecision.choose(true, "http://kitchen.local", pairing)
        )
        assertEquals(
            PairingChoice.CONFIRM_SWITCH,
            PairingDecision.choose(true, null, pairing)
        )
    }
}
