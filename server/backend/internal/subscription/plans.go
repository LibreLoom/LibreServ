package subscription

import (
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type Plan struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	PriceMonthly       int     `json:"price_monthly"`
	CreditCapUSD       float64 `json:"credit_cap_usd"`
	HumanEscalation    bool    `json:"human_escalation"`
	SelfHealing        bool    `json:"self_healing"`
	SelfHealingDefault bool    `json:"self_healing_default"`
}

func Plans() []Plan {
	cfg := config.Get()
	if cfg == nil || len(cfg.Support.Plans) == 0 {
		return defaultPlans()
	}
	var plans []Plan
	for _, p := range cfg.Support.Plans {
		plans = append(plans, Plan{
			ID:                 p.ID,
			Name:               p.Name,
			PriceMonthly:       p.PriceMonthly,
			CreditCapUSD:       p.CreditCapUSD,
			HumanEscalation:    p.HumanEscalation,
			SelfHealing:        p.SelfHealing,
			SelfHealingDefault: p.SelfHealingDefault,
		})
	}
	return plans
}

func PlanByID(id string) *Plan {
	for _, p := range Plans() {
		if p.ID == id {
			return &p
		}
	}
	return nil
}

func DefaultPlan() *Plan {
	if p := PlanByID("free"); p != nil {
		return p
	}
	plans := Plans()
	if len(plans) > 0 {
		return &plans[0]
	}
	return nil
}

func defaultPlans() []Plan {
	return []Plan{
		{ID: "free", Name: "Free", PriceMonthly: 0, CreditCapUSD: 0, HumanEscalation: false, SelfHealing: false, SelfHealingDefault: false},
		{ID: "basic", Name: "Basic Support", PriceMonthly: 1500, CreditCapUSD: 10, HumanEscalation: false, SelfHealing: true, SelfHealingDefault: false},
		{ID: "premium", Name: "Premium Support", PriceMonthly: 2500, CreditCapUSD: 20, HumanEscalation: true, SelfHealing: true, SelfHealingDefault: true},
	}
}
