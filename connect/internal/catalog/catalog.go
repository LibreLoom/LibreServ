package catalog

import "encoding/json"

// Plan represents a subscription plan with its limits.
type Plan struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	PriceMonthlyCents int    `json:"price_monthly"`
	Limits            Limits `json:"limits"`
}

// Limits defines the per-plan service allowances.
type Limits struct {
	BackupGB         int    `json:"backup_gb"`
	AICreditCents    int    `json:"ai_credit_cents"`
	SMTPMonthly      int    `json:"smtp_monthly"`
	AIMessagesPerDay int    `json:"ai_messages_per_day"`
	Domain           string `json:"domain"`
	HumanSupport     bool   `json:"human_support"`
	TunnelGBPerMo    int    `json:"tunnel_gb_per_mo"`
}

// ServiceCost holds verified upstream costs (from PLAN.md §2).
type ServiceCost struct {
	BackupStoragePerTBMonth float64 // Backblaze B2: $6.95
	BackupEgressPerGB       float64 // B2: free up to 3x storage, then $0.01/GB
	SMTPPerEmail            float64 // Resend: $0.0009/email
	AgentInputPerMToken     float64 // GLM-5.2: $0.30/M input
	AgentOutputPerMToken    float64 // GLM-5.2: $1.05/M output
	ReviewInputPerMToken    float64 // DSv4 Pro: $0.35/M input
	ReviewOutputPerMToken   float64 // DSv4 Pro: $0.80/M output
}

var plans = []Plan{
	{
		ID:                "free",
		Name:              "Connect Free",
		Description:       "Get started with basic services. No credit card required.",
		PriceMonthlyCents: 0,
		Limits: Limits{
			BackupGB:         0,
			AICreditCents:    0,
			SMTPMonthly:      30,
			AIMessagesPerDay: 50,
			Domain:           "*.free.servers.libreloom.org",
			HumanSupport:     false,
			TunnelGBPerMo:    0, // 0 = unlimited — Cloudflare Tunnel has no data cap
		},
	},
	{
		ID:                "lite",
		Name:              "Connect Base",
		Description:       "All services with a generous monthly allowance. Pay only for overage.",
		PriceMonthlyCents: 600,
		Limits: Limits{
			BackupGB:         100,
			AICreditCents:    200,
			SMTPMonthly:      250,
			AIMessagesPerDay: 0,
			Domain:           "*.servers.libreloom.org",
			HumanSupport:     true,
			TunnelGBPerMo:    0, // 0 = unlimited — Cloudflare Tunnel has no data cap
		},
	},
	{
		ID:                "one",
		Name:              "Connect One",
		Description:       "Everything included with the largest allowance. Best value for active users.",
		PriceMonthlyCents: 2500,
		Limits: Limits{
			BackupGB:         1024,
			AICreditCents:    500,
			SMTPMonthly:      2500,
			AIMessagesPerDay: 0,
			Domain:           "*.servers.libreloom.org",
			HumanSupport:     true,
			TunnelGBPerMo:    0, // 0 = unlimited — Cloudflare Tunnel has no data cap
		},
	},
}

// Costs holds verified upstream provider costs.
var Costs = ServiceCost{
	BackupStoragePerTBMonth: 6.95,
	BackupEgressPerGB:       0.01,
	SMTPPerEmail:            0.0009,
	AgentInputPerMToken:     0.30,
	AgentOutputPerMToken:    1.05,
	ReviewInputPerMToken:    0.35,
	ReviewOutputPerMToken:   0.80,
}

// Plans returns all plan definitions.
func Plans() []Plan {
	return plans
}

// PlanByID returns a plan by ID, or nil if not found.
func PlanByID(id string) *Plan {
	for i := range plans {
		if plans[i].ID == id {
			return &plans[i]
		}
	}
	return nil
}

// LimitsJSON returns the plan limits as a JSON string for DB storage.
func (l Limits) JSON() string {
	b, _ := json.Marshal(l)
	return string(b)
}

// PlanName returns the human-readable name for a plan ID.
func PlanName(id string) string {
	if p := PlanByID(id); p != nil {
		return p.Name
	}
	return "Connect Free"
}

// IsPaidPlan returns true if the plan requires payment.
func IsPaidPlan(planID string) bool {
	return planID == "lite" || planID == "one"
}

// HasHumanSupport returns true if the plan includes human support.
func HasHumanSupport(planID string) bool {
	if p := PlanByID(planID); p != nil {
		return p.Limits.HumanSupport
	}
	return false
}
