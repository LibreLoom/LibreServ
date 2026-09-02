package database

import (
	"context"
	"database/sql"
)

// DB wraps *sql.DB and rewrites ? placeholders for PostgreSQL.
type DB struct {
	*sql.DB
	driver Driver
}

func (db *DB) Driver() Driver { return db.driver }

func (db *DB) Exec(query string, args ...any) (sql.Result, error) {
	return db.DB.Exec(rebind(db.driver, query), args...)
}

func (db *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return db.DB.ExecContext(ctx, rebind(db.driver, query), args...)
}

func (db *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return db.DB.Query(rebind(db.driver, query), args...)
}

func (db *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return db.DB.QueryContext(ctx, rebind(db.driver, query), args...)
}

func (db *DB) QueryRow(query string, args ...any) *sql.Row {
	return db.DB.QueryRow(rebind(db.driver, query), args...)
}

func (db *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return db.DB.QueryRowContext(ctx, rebind(db.driver, query), args...)
}

func (db *DB) Begin() (*Tx, error) {
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &Tx{Tx: tx, driver: db.driver}, nil
}

func (db *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*Tx, error) {
	tx, err := db.DB.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &Tx{Tx: tx, driver: db.driver}, nil
}

// Tx wraps sql.Tx with placeholder rebinding.
type Tx struct {
	*sql.Tx
	driver Driver
}

func (tx *Tx) Exec(query string, args ...any) (sql.Result, error) {
	return tx.Tx.Exec(rebind(tx.driver, query), args...)
}

func (tx *Tx) Query(query string, args ...any) (*sql.Rows, error) {
	return tx.Tx.Query(rebind(tx.driver, query), args...)
}

func (tx *Tx) QueryRow(query string, args ...any) *sql.Row {
	return tx.Tx.QueryRow(rebind(tx.driver, query), args...)
}
