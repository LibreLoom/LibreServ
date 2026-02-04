// Package database provides database operations including transaction support.
package database

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// TxFn is a function that operates within a database transaction
type TxFn func(*sql.Tx) error

// BeginTx starts a transaction with the given context and options.
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	return d.db.BeginTx(ctx, opts)
}

// WithTransaction executes a function within a database transaction.
// It handles commit/rollback automatically and provides proper error handling.
func (d *DB) WithTransaction(ctx context.Context, fn TxFn) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			// Rollback on panic and re-panic
			if rbErr := tx.Rollback(); rbErr != nil {
				slog.Error("failed to rollback transaction after panic", "error", rbErr)
			}
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		// Attempt rollback on error
		if rbErr := tx.Rollback(); rbErr != nil {
			slog.Error("failed to rollback transaction", "error", rbErr)
			// Return both errors
			return fmt.Errorf("transaction failed: %v (rollback failed: %w)", err, rbErr)
		}
		return fmt.Errorf("transaction failed: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// WithTransactionResult executes a function within a transaction and returns a result.
// Similar to WithTransaction but allows returning a value.
func WithTransactionResult[T any](d *DB, ctx context.Context, fn func(*sql.Tx) (T, error)) (T, error) {
	var result T

	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return result, fmt.Errorf("failed to begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			if rbErr := tx.Rollback(); rbErr != nil {
				slog.Error("failed to rollback transaction after panic", "error", rbErr)
			}
			panic(p)
		}
	}()

	result, err = fn(tx)
	if err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			slog.Error("failed to rollback transaction", "error", rbErr)
			return result, fmt.Errorf("transaction failed: %v (rollback failed: %w)", err, rbErr)
		}
		return result, fmt.Errorf("transaction failed: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return result, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return result, nil
}

// TransactionalOperation represents an operation that can be part of a transaction
type TransactionalOperation struct {
	Name string
	Fn   func(*sql.Tx) error
}

// ExecuteOperations executes multiple operations within a single transaction.
// If any operation fails, all previous operations are rolled back.
func (d *DB) ExecuteOperations(ctx context.Context, operations []TransactionalOperation) error {
	return d.WithTransaction(ctx, func(tx *sql.Tx) error {
		for _, op := range operations {
			if err := op.Fn(tx); err != nil {
				return fmt.Errorf("operation %s failed: %w", op.Name, err)
			}
		}
		return nil
	})
}
