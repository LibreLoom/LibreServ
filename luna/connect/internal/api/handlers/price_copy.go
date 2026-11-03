package handlers

import (
	"fmt"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
)

// PriceCopy is the one sentence the website and the app show about what cloud
// backup costs. It is built from the billing constants so the words cannot
// drift from the arithmetic: change MinimumMonthlyUSD or DollarsPerGB and this
// sentence changes with it.
//
// Plain language rules apply — this is read by someone who does not work in
// this field. Say the real numbers and what they mean, in as few words as it
// takes.
func PriceCopy() string {
	return fmt.Sprintf(
		"Cloud backup costs $%s per terabyte each month, based on how much you store on average. "+
			"A month costs at least $%.0f once you have something stored. "+
			"Downloads are free up to %d× what you store; extra download traffic is $%.2f per GB.",
		formatDollarsPerTB(), billing.MinimumMonthlyUSD, billing.EgressFreeMultiplier, billing.DollarsPerEgressGB)
}

// formatDollarsPerTB renders the per-terabyte price without a trailing .00, so
// the sentence reads "$8 per terabyte" rather than "$8.00 per terabyte".
func formatDollarsPerTB() string {
	if billing.DollarsPerTB == float64(int(billing.DollarsPerTB)) {
		return fmt.Sprintf("%.0f", billing.DollarsPerTB)
	}
	return fmt.Sprintf("%.2f", billing.DollarsPerTB)
}
