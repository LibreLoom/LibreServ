package main

import "gt.plainskill.net/LibreLoom/LibreServ/internal/email"

// mfaOTPSender adapts *email.Sender to the api.EmailSender (SendOTP) interface
// for the MFA email-OTP flow. main.go only constructs it when NewSender() returns
// a non-nil sender (i.e. SMTP is configured); otherwise email MFA stays
// disabled so an admin is never softlocked out of their own device.
type mfaOTPSender struct{ s *email.Sender }

func (m mfaOTPSender) SendOTP(to, code string) error {
	return m.s.Send([]string{to}, "Your LibreServ sign-in code",
		"Your sign-in code is "+code+". It expires in 10 minutes.")
}

func (m mfaOTPSender) SendInvite(to, inviteURL string) error {
	return m.s.Send([]string{to}, "You're invited to LibreServ",
		"Set up your account: "+inviteURL)
}
