package setup

var validMainSteps = map[string]bool{
	StepChecking:  true,
	StepWelcome:   true,
	StepPreflight: true,
	StepDomain:    true,
	StepAccount:   true,
	StepComplete:  true,
}

var validSubSteps = map[string]bool{
	SubHasDomain:     true,
	SubRegistrarPick: true,
	SubSearchDomain:  true,
	SubProviderPick:  true,
	SubCFNSGuide:     true,
	SubDomainInput:   true,
	SubTokenInput:    true,
	SubConnecting:    true,
	SubConnected:     true,
}

var allowedStepDataKeys = map[string]bool{
	"preflight_passed": true,
	"domain_completed": true,
	"domain_skipped":   true,
	"has_domain":       true,
	"provider":         true,
	"registrar":        true,
	"domain_name":      true,
	"cf_ns_confirmed":  true,
}

const (
	StepChecking  = "checking"
	StepWelcome   = "welcome"
	StepPreflight = "preflight"
	StepDomain    = "domain"
	StepAccount   = "account"
	StepComplete  = "complete"
)

const (
	SubHasDomain     = "has_domain"
	SubRegistrarPick = "registrar_pick"
	SubSearchDomain  = "search_domain"
	SubProviderPick  = "provider_pick"
	SubCFNSGuide     = "cf_ns_guide"
	SubDomainInput   = "domain_input"
	SubTokenInput    = "token_input"
	SubConnecting    = "connecting"
	SubConnected     = "connected"
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
