package store

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrDuplicate = errors.New("store: duplicate")
	ErrNotFound  = errors.New("store: not found")
	ErrConflict  = errors.New("store: conflict")
)

// mapErr translates pgx errors into the package sentinels.
func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return ErrDuplicate
		case "23503":
			return ErrNotFound
		}
	}
	return err
}
