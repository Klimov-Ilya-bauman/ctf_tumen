package store

import "context"

type User struct {
	ID       int64
	Username string
	PassHash string
	Pubkey   []byte
}

func (s *Store) CreateUser(ctx context.Context, username, passHash string) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO users(username, pass_hash) VALUES($1,$2) RETURNING id`,
		username, passHash).Scan(&id)
	if err != nil {
		return 0, mapErr(err)
	}
	return id, nil
}

func (s *Store) userBy(ctx context.Context, col string, arg any) (*User, error) {
	u := &User{}
	err := s.Pool.QueryRow(ctx,
		`SELECT id, username, pass_hash, pubkey FROM users WHERE `+col+`=$1`, arg).
		Scan(&u.ID, &u.Username, &u.PassHash, &u.Pubkey)
	if err != nil {
		return nil, mapErr(err)
	}
	return u, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	return s.userBy(ctx, "username", username)
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	return s.userBy(ctx, "id", id)
}

func (s *Store) SetPubkey(ctx context.Context, userID int64, pub []byte) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE users SET pubkey=$1 WHERE id=$2`, pub, userID)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
