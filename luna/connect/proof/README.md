# Billing proof

The billing rules, restated in [gdp-wired](https://github.com/monotykamary/gdp-wired)
and proven by its kernel — not sampled. `billing.mjs` proves the arithmetic;
`crosscheck.mjs` ties the proof to the Go code by checking the quantities the
implementation actually reports.

## Run

```sh
npm install gdp-wired
node billing.mjs      # proves the laws
node crosscheck.mjs   # checks the Go output against them
```

`crosscheck.mjs` reads `/tmp/go-cases.txt`, which is emitted by a temporary
test in `internal/billing` (see below). It is not part of `./ci`.

## What is proven

| Law | Why it matters |
|---|---|
| 375 GB × $0.008/GB = $3.00 | The floor quantity and the minimum are two constants; if one moves, the floor silently stops being $3 |
| A stored month bills at least $3 | The minimum holds for every size and egress |
| Usage above the minimum is billed as usage | No hidden minimum on top of a bill that already exceeds it |
| The minimum never discounts real storage | A large account is never under-charged |
| Up to 3× stored is free; beyond that, only the excess | Egress overage |
| A credit applies at most the invoice and at most the balance | A credit can reduce a bill to zero, never create money owed |
| A credit raises the balance by exactly its amount | The ledger explains the balance |
| A debit never goes negative | No overdraft |
| A law without the floor is refuted | The suite can fail |

## The one thing that is not exact

The Stripe meter bills whole GB, so a month below the minimum bills the minimum
**rounded up to the next GB** — at most $0.008 above $3.00, never below. That is
a property of the meter, not of the rule; `crosscheck.mjs` asserts the bound.

## Emitting the Go cases

```go
// internal/billing/zz_emit_test.go
func TestEmitCases(t *testing.T) {
	GB := int64(BytesPerGB)
	for _, gb := range []int64{0, 1, 3, 100, 374, 375, 376, 1000} {
		for _, over := range []int64{0, 1, 50, 199, 200, 250, 300, 400} {
			s, o := MeteredQuantities(gb*GB, over*GB)
			fmt.Printf("GOCASE %d %d %d %d %d\n", gb, over, s, o, s*MillsPerGBStorage+o*MillsPerGBEgress)
		}
	}
}
```

```sh
go test ./internal/billing/ -run TestEmitCases -v | grep '^GOCASE' > /tmp/go-cases.txt
```
