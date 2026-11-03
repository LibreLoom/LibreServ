package billing

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

// Credits are money we owe an account, held in our own ledger rather than at
// Stripe. They exist for the case we will hit: we get something wrong, and the
// fix is to give someone money back. A credit is applied to the next invoice
// we finalize, so a customer never has to ask for a refund through their bank.
//
// The ledger is deliberately small. It records every movement with the reason
// and the staff member who made it, so a balance can always be explained, and
// it is only ever changed by an explicit credit or by applying a balance to an
// invoice — never as a side effect of usage reporting.

var (
	// ErrCreditReasonRequired: a movement without a reason cannot be explained later.
	ErrCreditReasonRequired = errors.New("a credit needs a reason")
	// ErrCreditAmountInvalid: credits are positive cents; direction carries the sign.
	ErrCreditAmountInvalid = errors.New("credit amount must be positive")
	// ErrNoSuchAccount: the account id does not exist.
	ErrNoSuchAccount = errors.New("no such account")
)

// CreditEntry is one movement in an account's credit ledger.
type CreditEntry struct {
	ID          int64  `json:"id"`
	AmountCents int    `json:"amount_cents"`
	Direction   string `json:"direction"`
	Reason      string `json:"reason"`
	ReferenceID string `json:"reference_id,omitempty"`
	AdminID     string `json:"admin_id,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

// CreditBalance is an account's current credit, with the ledger that produced it.
type CreditBalance struct {
	BalanceCents int           `json:"balance_cents"`
	Entries      []CreditEntry `json:"entries"`
}

// GetCreditBalance returns the account's balance and recent ledger entries.
func GetCreditBalance(db *database.DB, accountID string) (CreditBalance, error) {
	out := CreditBalance{Entries: []CreditEntry{}}
	if db == nil || accountID == "" {
		return out, nil
	}
	err := db.QueryRow(`SELECT balance_cents FROM account_credits WHERE account_id = ?`, accountID).Scan(&out.BalanceCents)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	rows, err := db.Query(`SELECT id, amount_cents, direction, reason, COALESCE(reference_id, ''), COALESCE(admin_id, ''), created_at
		FROM credit_transactions WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, accountID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var e CreditEntry
		if err := rows.Scan(&e.ID, &e.AmountCents, &e.Direction, &e.Reason, &e.ReferenceID, &e.AdminID, &e.CreatedAt); err != nil {
			return out, err
		}
		out.Entries = append(out.Entries, e)
	}
	return out, rows.Err()
}

// AddCredit puts money on an account's balance. reason is required: a balance
// nobody can explain is worse than no balance at all. adminID is the staff
// member who did it, empty for an automatic credit.
func AddCredit(db *database.DB, accountID string, amountCents int, reason, referenceID, adminID string) error {
	if db == nil {
		return errors.New("no database")
	}
	if amountCents <= 0 {
		return ErrCreditAmountInvalid
	}
	if strings.TrimSpace(reason) == "" {
		return ErrCreditReasonRequired
	}
	var exists int
	if err := db.QueryRow(`SELECT 1 FROM accounts WHERE id = ?`, accountID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNoSuchAccount
		}
		return err
	}
	return applyMovement(db, accountID, amountCents, "credit", reason, referenceID, adminID)
}

// DeductCredit takes money off an account's balance, refusing to go negative.
// Only invoice application uses this; it is not a staff action.
func DeductCredit(db *database.DB, accountID string, amountCents int, reason, referenceID string) error {
	if db == nil {
		return errors.New("no database")
	}
	if amountCents <= 0 {
		return ErrCreditAmountInvalid
	}
	if reason == "" {
		return ErrCreditReasonRequired
	}
	var balance int
	err := db.QueryRow(`SELECT balance_cents FROM account_credits WHERE account_id = ?`, accountID).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("no credit balance to deduct from")
	}
	if err != nil {
		return err
	}
	if balance < amountCents {
		return fmt.Errorf("insufficient credit: have %d cents, need %d", balance, amountCents)
	}
	return applyMovement(db, accountID, amountCents, "debit", reason, referenceID, "")
}

// applyMovement writes the balance change and its ledger entry in one
// transaction, so the two can never disagree.
func applyMovement(db *database.DB, accountID string, amountCents int, direction, reason, referenceID, adminID string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	delta := amountCents
	if direction == "debit" {
		delta = -amountCents
	}
	now := time.Now().Unix()
	if _, err := tx.Exec(`INSERT INTO account_credits (account_id, balance_cents, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(account_id) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents, updated_at = excluded.updated_at`,
		accountID, delta, now); err != nil {
		return err
	}
	var ref, admin any
	if referenceID != "" {
		ref = referenceID
	}
	if adminID != "" {
		admin = adminID
	}
	if _, err := tx.Exec(`INSERT INTO credit_transactions (account_id, amount_cents, direction, reason, reference_id, admin_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		accountID, amountCents, direction, reason, ref, admin, now); err != nil {
		return err
	}
	return tx.Commit()
}

// ApplyCreditsToInvoice spends an account's balance against an invoice total
// and returns the amount actually applied. It never applies more than the
// balance or more than the invoice, so a balance can only ever reduce a bill
// to zero — never turn into money owed back automatically.
//
// invoiceCents is what the account was billed this period. Stripe has already
// collected it by the time we see the invoice, so the applied amount is
// credited back to the balance as a refund of that charge: the account's next
// invoice is smaller by exactly this much.
func ApplyCreditsToInvoice(db *database.DB, accountID, invoiceID string, invoiceCents int) (int, error) {
	if db == nil || accountID == "" || invoiceCents <= 0 {
		return 0, nil
	}
	var balance int
	err := db.QueryRow(`SELECT balance_cents FROM account_credits WHERE account_id = ?`, accountID).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	applied := balance
	if applied > invoiceCents {
		applied = invoiceCents
	}
	if applied <= 0 {
		return 0, nil
	}
	if err := DeductCredit(db, accountID, applied, "invoice_credit", invoiceID); err != nil {
		return 0, err
	}
	return applied, nil
}
