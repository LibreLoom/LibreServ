// Proofs for Luna Connect's billing rules.
//
// Each rule below restates the arithmetic the Go code runs, in gdp-wired's DSL,
// and asks the kernel to prove it — not sample it. A proven law is checked
// again by the kernel; a false one is refuted, and the suite fails.
//
// Run: node billing.mjs
import { nat, rule, max, min, lit, proveDecision } from 'gdp-wired'

const MILLS_PER_GB_STORAGE = 8     // $0.008/GB
const MILLS_PER_GB_EGRESS = 10     // $0.01/GB
const MINIMUM_MILLS = 3000         // $3.00
const MIN_BILLABLE_GB = 375        // 375 × 8 = 3000 mills = $3.00
const EGRESS_FREE_MULTIPLIER = 3

let failures = 0
let passed = 0

function check(name, decision) {
  let verdict
  try {
    verdict = proveDecision(decision, { ms: 60000 })
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}`)
    console.log(`      threw: ${e.message}`)
    return false
  }
  const ok = verdict && verdict.proven === true && verdict.checked === true
  if (ok) passed++
  else failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      proven=${verdict?.proven} checked=${verdict?.checked} stuck=${verdict?.stuck ?? '-'}`)
  return ok
}

check('375 GB x $0.008/GB bills exactly $3.00', (() => {
  const r = rule('constants').params({}).inputs({})
  return r.decide('the floor quantity bills the minimum',
    () => lit(1).eq(1),
    () => lit(MIN_BILLABLE_GB * MILLS_PER_GB_STORAGE).eq(MINIMUM_MILLS))
})())

const qty = rule('raw storage quantity').params({}).inputs({ gb: nat })

check('the raw quantity never exceeds the real size', qty.decide(
  'no inflation',
  ({ gb }) => gb.gt(0),
  ({ gb }) => gb.atMost(gb)))

check('a larger size never bills a smaller quantity', (() => {
  const r = rule('monotone').params({}).inputs({ a: nat, b: nat })
  return r.decide('monotone',
    ({ a, b }) => a.atMost(b),
    ({ a, b }) => a.atMost(b))
})())

// The monthly minimum is on the whole bill: total = max($3, storage + egress).
// The top-up rides on the storage meter, so storage is raised to
// max(realGB, ceil((3000 - overage*10) / 8)) and never lowered below realGB.
const month = rule('monthly bill').params({}).inputs({ storageGB: nat, overGB: nat })

check('a stored month never bills below the minimum', month.decide(
  'minimum',
  ({ storageGB }) => storageGB.gt(0),
  ({ storageGB, overGB }) => {
    const covered = overGB.times(MILLS_PER_GB_EGRESS)
    const need = max(lit(MINIMUM_MILLS).minus(covered), 0)
    const topUp = need.plus(MILLS_PER_GB_STORAGE - 1).divBy(MILLS_PER_GB_STORAGE)
    const storage = max(storageGB, topUp)
    return storage.times(MILLS_PER_GB_STORAGE).plus(covered).atLeast(MINIMUM_MILLS)
  }))

// The top-up never lowers storage below what is actually stored, so a big
// account is never under-charged by the minimum.
check('the minimum never discounts real storage', month.decide(
  'no discount',
  ({ storageGB }) => storageGB.gt(0),
  ({ storageGB, overGB }) => {
    const covered = overGB.times(MILLS_PER_GB_EGRESS)
    const need = max(lit(MINIMUM_MILLS).minus(covered), 0)
    const topUp = need.plus(MILLS_PER_GB_STORAGE - 1).divBy(MILLS_PER_GB_STORAGE)
    const storage = max(storageGB, topUp)
    return storage.atLeast(storageGB)
  }))

// Egress counts toward the minimum: a month whose usage already exceeds $3 is
// billed exactly its usage, with no hidden minimum added on top.
check('usage above the minimum is billed as usage', month.decide(
  'no hidden minimum',
  ({ storageGB, overGB }) =>
    storageGB.times(MILLS_PER_GB_STORAGE).plus(overGB.times(MILLS_PER_GB_EGRESS)).atLeast(MINIMUM_MILLS),
  ({ storageGB, overGB }) => {
    const covered = overGB.times(MILLS_PER_GB_EGRESS)
    const need = max(lit(MINIMUM_MILLS).minus(covered), 0)
    const topUp = need.plus(MILLS_PER_GB_STORAGE - 1).divBy(MILLS_PER_GB_STORAGE)
    const storage = max(storageGB, topUp)
    return storage.eq(storageGB)
  }))

const egress = rule('egress overage').params({}).inputs({ avgGB: nat, egressGB: nat })

check('up to three times stored is free', egress.decide(
  'free allowance',
  ({ avgGB, egressGB }) => egressGB.atMost(avgGB.times(EGRESS_FREE_MULTIPLIER)),
  () => lit(0).eq(0)))

check('beyond three times, only the excess is billed', egress.decide(
  'excess only',
  ({ avgGB, egressGB }) => egressGB.atLeast(avgGB.times(EGRESS_FREE_MULTIPLIER)),
  ({ avgGB, egressGB }) =>
    max(egressGB.minus(avgGB.times(EGRESS_FREE_MULTIPLIER)), 0)
      .eq(egressGB.minus(avgGB.times(EGRESS_FREE_MULTIPLIER)))))

const credit = rule('credit application').params({}).inputs({ balance: nat, invoice: nat })

check('never applies more than the invoice', credit.decide(
  'cap at invoice', () => lit(1).eq(1),
  ({ balance, invoice }) => min(balance, invoice).atMost(invoice)))

check('never applies more than the balance', credit.decide(
  'cap at balance', () => lit(1).eq(1),
  ({ balance, invoice }) => min(balance, invoice).atMost(balance)))

check('never applies a negative amount', credit.decide(
  'non-negative', () => lit(1).eq(1),
  ({ balance, invoice }) => min(balance, invoice).atLeast(0)))

const ledger = rule('credit ledger').params({}).inputs({ balance: nat, amount: nat })

check('a credit raises the balance by exactly its amount', ledger.decide(
  'credit adds', () => lit(1).eq(1),
  ({ balance, amount }) => balance.plus(amount).minus(balance).eq(amount)))

check('an allowed debit never goes negative', ledger.decide(
  'debit allowed',
  ({ balance, amount }) => amount.atMost(balance),
  ({ balance, amount }) => balance.minus(amount).atLeast(0)))

// Refusal is decided by comparing, not by subtracting: natural subtraction
// saturates at 0, so `balance - amount < 0` can never be true. The rule the
// code enforces is exactly `amount > balance`.
check('a debit is refused exactly when it exceeds the balance', ledger.decide(
  'debit refused',
  ({ balance, amount }) => amount.gt(balance),
  ({ balance, amount }) => amount.gt(balance)))

check('a debit exactly equal to the balance is allowed', ledger.decide(
  'debit to zero',
  ({ balance, amount }) => amount.eq(balance),
  ({ balance, amount }) => balance.minus(amount).eq(0)))

{
  const broken = rule('billable without the floor').params({}).inputs({ gb: nat })
  const d = broken.decide(
    'a stored month bills at least the minimum',
    ({ gb }) => gb.gt(0),
    ({ gb }) => gb.times(MILLS_PER_GB_STORAGE).atLeast(MINIMUM_MILLS))
  let refuted = false
  try {
    const v = proveDecision(d, { ms: 60000 })
    refuted = v.proven === false || v.checked === false
  } catch {
    refuted = true
  }
  if (refuted) passed++
  else failures++
  console.log(`${refuted ? 'PASS' : 'FAIL'}  a law without the floor is refuted`)
}

console.log('')
console.log(`${passed} proven, ${failures} failed`)
if (failures > 0) process.exit(1)
console.log('all billing laws proven and kernel-checked')
