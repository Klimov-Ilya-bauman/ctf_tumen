package store

import (
	"context"
	"time"
)

func (s *Store) CreateSession(ctx context.Context, hash string, uid int64, expires time.Time) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO sessions(token, user_id, expires_at) VALUES($1,$2,$3)`, hash, uid, expires)
	return mapErr(err)
}

func (s *Store) SessionUser(ctx context.Context, hash string) (int64, error) {
	var uid int64
	err := s.Pool.QueryRow(ctx, `SELECT user_id FROM sessions WHERE token=$1 AND expires_at>now() AND revoked_at IS NULL`, hash).Scan(&uid)
	return uid, mapErr(err)
}

func (s *Store) DeleteSession(ctx context.Context, hash string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE token=$1`, hash)
	return mapErr(err)
}
