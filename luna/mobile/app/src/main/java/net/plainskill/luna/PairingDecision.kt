package net.plainskill.luna

/** What a `luna://pair` link should do to the sign-in screen. */
enum class PairingChoice {
    /** Signed in to this same Luna already: nothing to fill. */
    ALREADY_CONNECTED,

    /** Signed in somewhere else: confirm the switch before re-pointing uploads. */
    CONFIRM_SWITCH,

    /** Signed out: confirm before filling the address and access token. */
    CONFIRM_FILL,
}

/**
 * A `luna://pair` link can be sent by anything — a web page, a chat message,
 * another app — so it never fills the sign-in fields without the person
 * saying yes. Signed in, the same Luna is a no-op and a different one asks
 * about switching (photo uploads move with the address). Signed out, every
 * link asks before it fills the address and access token.
 */
object PairingDecision {
    fun choose(signedIn: Boolean, currentUrl: String?, pairing: Pairing): PairingChoice = when {
        !signedIn -> PairingChoice.CONFIRM_FILL
        currentUrl != null && currentUrl.equals(pairing.url, ignoreCase = true) ->
            PairingChoice.ALREADY_CONNECTED
        else -> PairingChoice.CONFIRM_SWITCH
    }
}
