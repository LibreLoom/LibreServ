// Ties the proven model to the Go code: every quantity the Go implementation
// reports must satisfy the laws proven in billing.mjs.
import { readFileSync } from 'node:fs'

const MILLS_STORAGE = 8, MILLS_EGRESS = 10, MINIMUM = 3000, MIN_GB = 375
const lines = readFileSync('/tmp/go-cases.txt', 'utf8').trim().split('\n')
let bad = 0, n = 0

for (const line of lines) {
  const [, gbS, overS, storS, overOutS, totalS] = line.split(' ')
  const gb = Number(gbS), over = Number(overS)
  const stor = Number(storS), overOut = Number(overOutS), total = Number(totalS)
  n++

  const overage = Math.max(0, over - 3 * gb)   // free up to 3x stored

  // Law: nothing stored reports nothing on either meter.
  if (gb === 0 && (stor !== 0 || overOut !== 0)) {
    console.log(`FAIL empty account gb=${gb} over=${over} reported ${stor}/${overOut}`); bad++
  }
  // Law: a stored month bills at least the minimum.
  if (gb > 0 && total < MINIMUM) {
    console.log(`FAIL below minimum gb=${gb} over=${over} total=${total}`); bad++
  }
  // Law: total is exactly the two meters summed.
  if (stor * MILLS_STORAGE + overOut * MILLS_EGRESS !== total) {
    console.log(`FAIL total mismatch gb=${gb} over=${over}`); bad++
  }
  // Law: storage never bills less than what is actually stored.
  if (stor < gb) {
    console.log(`FAIL storage below real size gb=${gb} stor=${stor}`); bad++
  }
  // Law: when the minimum is met by usage alone, storage is the real size
  // (no top-up on top of an already-sufficient bill).
  if (gb * MILLS_STORAGE + overage * MILLS_EGRESS >= MINIMUM && stor !== gb) {
    console.log(`FAIL needless top-up gb=${gb} over=${over} stor=${stor}`); bad++
  }
  // Law: when usage is below the minimum, the bill is the minimum rounded up
  // to a whole GB — at most one GB of storage ($8 mill) above it, never below.
  if (gb > 0 && gb * MILLS_STORAGE + overage * MILLS_EGRESS < MINIMUM) {
    if (total < MINIMUM) {
      console.log(`FAIL below minimum gb=${gb} over=${over} total=${total}`); bad++
    }
    if (total > MINIMUM + MILLS_STORAGE) {
      console.log(`FAIL overshoot beyond one GB gb=${gb} over=${over} total=${total}`); bad++
    }
  }
  // Law: the reported overage is the real overage — except that an account
  // storing nothing reports nothing on either meter, whatever it downloaded.
  if (gb > 0 && overOut !== overage) {
    console.log(`FAIL overage mismatch gb=${gb} over=${over} got=${overOut} want=${overage}`); bad++
  }
}

console.log(`${n} Go cases checked against the proven laws, ${bad} violations`)
process.exit(bad === 0 ? 0 : 1)
