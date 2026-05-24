package subscription

import "errors"

var ErrCreditExceeded = errors.New("credit limit exceeded for current billing period")
