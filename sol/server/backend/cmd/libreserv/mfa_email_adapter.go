package main

import "gt.plainskill.net/LibreLoom/LibreServ/internal/email"

// mfaOTPSender adapts *email.Sender to the api.EmailSender (SendOTP) interface
// for the MFA email-OTP flow. main.go only constructs it when NewSender() returns
// a non-nil sender (i.e. SMTP is configured); otherwise email MFA stays
// disabled so an admin is never softlocked out of their own device.
type mfaOTPSender struct{ s *email.Sender }

func (m mfaOTPSender) SendOTP(to, code string) error {
	subject := "Your LibreServ sign-in code"
	body := "Your sign-in code is " + code + ". It expires in 10 minutes."
	htmlBody, err := email.RenderOTPEmail(subject, code)
	if err != nil {
		return m.s.Send([]string{to}, subject, body)
	}
	return m.s.SendHTMLEmail([]string{to}, subject, htmlBody)
}

func (m mfaOTPSender) SendInvite(to, inviteURL string) error {
	return m.s.Send([]string{to}, "You're invited to LibreServ",
		"Set up your account: "+inviteURL)
}
