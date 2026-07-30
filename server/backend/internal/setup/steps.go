package setup

var validMainSteps = map[string]bool{
	StepWelcome:          true,
	StepPreflight:        true,
	StepDomain:           true,
	StepRemoteAccess:     true,
	StepSMTP:             true,
	StepAccount:          true,
	StepExternalServices: true,
	StepMfa:              true,
	StepComplete:         true,
}

var validSubSteps = map[string]bool{
	SubHasDomain:       true,
	SubRegistrarPick:   true,
	SubSearchDomain:    true,
	SubProviderPick:    true,
	SubCFNSGuide:       true,
	SubDomainInput:     true,
	SubTokenInput:      true,
	SubConnecting:      true,
	SubConnected:       true,
	SubSMTPProvider:    true,
	SubSMTPCredentials: true,
	SubSMTPTesting:     true,
	SubSMTPConnected:   true,
	SubSMTSkipConfirm:  true,
}

var allowedStepDataKeys = map[string]bool{
	"preflight_passed":          true,
	"account_completed":         true,
	"admin_email":               true,
	"domain_completed":          true,
	"domain_skipped":            true,
	"remote_access_completed":   true,
	"remote_access_skipped":     true,
	"has_domain":                true,
	"provider":                  true,
	"registrar":                 true,
	"domain_name":               true,
	"cf_ns_confirmed":           true,
	"smtp_completed":            true,
	"smtp_skipped":              true,
	"smtp_provider":             true,
	"connect_activated":         true,
	"external_services_skipped": true,
	"mfa_completed":             true,
}

const (
	StepWelcome          = "welcome"
	StepPreflight        = "preflight"
	StepDomain           = "domain"
	StepRemoteAccess     = "remote_access"
	StepSMTP             = "smtp"
	StepAccount          = "account"
	StepExternalServices = "external_services"
	StepMfa              = "mfa"
	StepComplete         = "complete"
)

const (
	SubHasDomain       = "has_domain"
	SubRegistrarPick   = "registrar_pick"
	SubSearchDomain    = "search_domain"
	SubProviderPick    = "provider_pick"
	SubCFNSGuide       = "cf_ns_guide"
	SubDomainInput     = "domain_input"
	SubTokenInput      = "token_input"
	SubConnecting      = "connecting"
	SubConnected       = "connected"
	SubSMTPProvider    = "smtp_provider_pick"
	SubSMTPCredentials = "smtp_credentials"
	SubSMTPTesting     = "smtp_testing"
	SubSMTPConnected   = "smtp_connected"
	SubSMTSkipConfirm  = "skip_confirm"
)

func IsValidMainStep(step string) bool {
	return validMainSteps[step]
}

func IsValidSubStep(step string) bool {
	return validSubSteps[step]
}

func ValidateStepData(data map[string]interface{}) bool {
	for k := range data {
		if !allowedStepDataKeys[k] {
			return false
		}
	}
	return true
}
