package billing

import (
	"errors"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func creditTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES ('acct_1', 'a@b.co', 'x', 1)`)
	return db
}

func TestAddCreditRequiresReason(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "acct_1", 500, "", "", "admin_1"); !errors.Is(err, ErrCreditReasonRequired) {
		t.Fatalf("empty reason: %v", err)
	}
	if err := AddCredit(db, "acct_1", 500, "   ", "", "admin_1"); !errors.Is(err, ErrCreditReasonRequired) {
		t.Fatalf("whitespace reason should be refused, got %v", err)
	}
}

func TestAddCreditRejectsNonPositive(t *testing.T) {
	db := creditTestDB(t)
	for _, amount := range []int{0, -100} {
		if err := AddCredit(db, "acct_1", amount, "goodwill", "", "admin_1"); !errors.Is(err, ErrCreditAmountInvalid) {
			t.Fatalf("amount %d: %v", amount, err)
		}
	}
}

func TestAddCreditUnknownAccount(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "nobody", 500, "goodwill", "", "admin_1"); !errors.Is(err, ErrNoSuchAccount) {
		t.Fatalf("unknown account: %v", err)
	}
}

func TestCreditBalanceAndLedger(t *testing.T) {
	db := creditTestDB(t)
	bal, err := GetCreditBalance(db, "acct_1")
	if err != nil {
		t.Fatal(err)
	}
	if bal.BalanceCents != 0 || len(bal.Entries) != 0 {
		t.Fatalf("new account: %+v", bal)
	}

	if err := AddCredit(db, "acct_1", 300, "billed twice", "inv_1", "admin_1"); err != nil {
		t.Fatal(err)
	}
	if err := AddCredit(db, "acct_1", 200, "goodwill", "", "admin_2"); err != nil {
		t.Fatal(err)
	}
	bal, err = GetCreditBalance(db, "acct_1")
	if err != nil {
		t.Fatal(err)
	}
	if bal.BalanceCents != 500 {
		t.Fatalf("balance=%d want 500", bal.BalanceCents)
	}
	if len(bal.Entries) != 2 {
		t.Fatalf("entries=%d want 2", len(bal.Entries))
	}
	// Newest first, with the reason and the staff member preserved.
	if bal.Entries[0].Reason != "goodwill" || bal.Entries[0].AdminID != "admin_2" {
		t.Fatalf("newest entry: %+v", bal.Entries[0])
	}
	if bal.Entries[1].ReferenceID != "inv_1" {
		t.Fatalf("reference lost: %+v", bal.Entries[1])
	}
}

func TestDeductCreditNeverGoesNegative(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "acct_1", 500, "goodwill", "", "admin_1"); err != nil {
		t.Fatal(err)
	}
	if err := DeductCredit(db, "acct_1", 600, "invoice_credit", "inv_1"); err == nil {
		t.Fatal("deducting more than the balance must fail")
	}
	bal, _ := GetCreditBalance(db, "acct_1")
	if bal.BalanceCents != 500 {
		t.Fatalf("failed deduction changed the balance: %d", bal.BalanceCents)
	}
	if err := DeductCredit(db, "acct_1", 500, "invoice_credit", "inv_1"); err != nil {
		t.Fatal(err)
	}
	bal, _ = GetCreditBalance(db, "acct_1")
	if bal.BalanceCents != 0 {
		t.Fatalf("balance=%d want 0", bal.BalanceCents)
	}
}

// A credit can reduce a bill to zero but never turn into money owed back.
func TestApplyCreditsToInvoice(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "acct_1", 500, "goodwill", "", "admin_1"); err != nil {
		t.Fatal(err)
	}

	// Invoice of $3.00 with $5.00 of credit applies only the invoice amount.
	applied, err := ApplyCreditsToInvoice(db, "acct_1", "inv_1", 300)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 300 {
		t.Fatalf("applied=%d want 300", applied)
	}
	bal, _ := GetCreditBalance(db, "acct_1")
	if bal.BalanceCents != 200 {
		t.Fatalf("balance=%d want 200", bal.BalanceCents)
	}

	// A second, larger invoice spends the rest.
	applied, err = ApplyCreditsToInvoice(db, "acct_1", "inv_2", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 200 {
		t.Fatalf("applied=%d want 200", applied)
	}
	bal, _ = GetCreditBalance(db, "acct_1")
	if bal.BalanceCents != 0 {
		t.Fatalf("balance=%d want 0", bal.BalanceCents)
	}

	// Nothing left: nothing applied, no error.
	applied, err = ApplyCreditsToInvoice(db, "acct_1", "inv_3", 1000)
	if err != nil || applied != 0 {
		t.Fatalf("empty balance applied=%d err=%v", applied, err)
	}
}

func TestApplyCreditsToInvoiceIgnoresNonPositive(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "acct_1", 500, "goodwill", "", "admin_1"); err != nil {
		t.Fatal(err)
	}
	for _, cents := range []int{0, -100} {
		applied, err := ApplyCreditsToInvoice(db, "acct_1", "inv_x", cents)
		if err != nil || applied != 0 {
			t.Fatalf("invoice %d: applied=%d err=%v", cents, applied, err)
		}
	}
	bal, _ := GetCreditBalance(db, "acct_1")
	if bal.BalanceCents != 500 {
		t.Fatalf("balance changed to %d", bal.BalanceCents)
	}
}

// The $1 card check is held as credit, which is what the copy promises.
func TestCardCheckCreditIsSpendable(t *testing.T) {
	db := creditTestDB(t)
	if err := AddCredit(db, "acct_1", 100, "card check", "pi_1", ""); err != nil {
		t.Fatal(err)
	}
	applied, err := ApplyCreditsToInvoice(db, "acct_1", "inv_1", 300)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 100 {
		t.Fatalf("applied=%d want 100", applied)
	}
}
