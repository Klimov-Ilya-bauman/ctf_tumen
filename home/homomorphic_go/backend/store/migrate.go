package store

import (
	"context"
	_ "embed"
)

//go:embed schema.sql
var schemaSQL string

func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.Pool.Exec(ctx, schemaSQL)
	return err
}
