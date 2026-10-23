package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type Game struct {
	ID, BlackID int64
	WhiteID     *int64
	Status      string
	BoardC      []byte
	Turn        int16
	Version     int64
	BlackPubkey []byte
	WhitePubkey []byte
}

type Move struct {
	Seq       int
	BoardC    []byte
	CreatedAt time.Time
}

type Message struct {
	ID         int64
	SenderID   int64
	Ciphertext string
	CreatedAt  time.Time
}

const gameCols = `id, black_id, white_id, status, board_c, turn, version, black_pubkey, white_pubkey`

func scanGame(row pgx.Row) (Game, error) {
	var g Game
	err := row.Scan(&g.ID, &g.BlackID, &g.WhiteID, &g.Status, &g.BoardC, &g.Turn, &g.Version, &g.BlackPubkey, &g.WhitePubkey)
	return g, err
}

// gameKey serializes account-key changes with creation/join and snapshots the key.
func gameKey(ctx context.Context, tx pgx.Tx, userID int64, supplied []byte) ([]byte, error) {
	var key []byte
	if err := tx.QueryRow(ctx, `SELECT pubkey FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&key); err != nil {
		return nil, mapErr(err)
	}
	if supplied != nil {
		key = supplied
	}
	if !validGameKey(key) {
		return nil, ErrConflict
	}
	if supplied != nil {
		if _, err := tx.Exec(ctx, `UPDATE users SET pubkey=$1 WHERE id=$2`, key, userID); err != nil {
			return nil, mapErr(err)
		}
	}
	return key, nil
}

func validGameKey(key []byte) bool {
	if len(key) != 19 {
		return false
	}
	for _, v := range key {
		if v == 0 || v >= 251 {
			return false
		}
	}
	return true
}

func (s *Store) CreateGame(ctx context.Context, blackID int64, pub []byte) (int64, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	key, err := gameKey(ctx, tx, blackID, pub)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx,
		`INSERT INTO games(black_id, status, black_pubkey, keys_frozen) VALUES($1,'waiting',$2,true) RETURNING id`,
		blackID, key).Scan(&id)
	if err != nil {
		return 0, mapErr(err)
	}
	return id, mapErr(tx.Commit(ctx))
}

func (s *Store) JoinGame(ctx context.Context, gameID, whiteID int64, pub []byte) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	key, err := gameKey(ctx, tx, whiteID, pub)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE games SET white_id=$1,status='active',version=version+1,white_pubkey=$3
		 WHERE id=$2 AND white_id IS NULL AND status='waiting' AND black_id<>$1
		 AND black_pubkey IS NOT NULL`, whiteID, gameID, key)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() > 0 {
		return mapErr(tx.Commit(ctx))
	}
	var one int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM games WHERE id=$1`, gameID).Scan(&one); err != nil {
		return mapErr(err)
	}
	return ErrConflict
}

func (s *Store) GetGame(ctx context.Context, id int64) (*Game, error) {
	g, err := scanGame(s.Pool.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE id=$1`, id))
	if err != nil {
		return nil, mapErr(err)
	}
	return &g, nil
}

func (s *Store) ListGames(ctx context.Context, before int64, limit int) ([]Game, error) {
	if before < 0 || limit < 1 || limit > 100 {
		return nil, ErrConflict
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+gameCols+` FROM games WHERE ($1::bigint=0 OR id<$1) ORDER BY id DESC LIMIT $2`, before, limit)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	var out []Game
	for rows.Next() {
		g, err := scanGame(rows)
		if err != nil {
			return nil, mapErr(err)
		}
		out = append(out, g)
	}
	return out, mapErr(rows.Err())
}

func (s *Store) ApplyMove(ctx context.Context, gameID, userID, version int64, boardC []byte) error {
	if len(boardC) != 361 {
		return ErrConflict
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx,
		`UPDATE games SET board_c=$1, turn=1-turn, version=version+1, updated_at=now()
		 WHERE id=$2 AND status='active' AND white_id IS NOT NULL AND version=$4
		 AND (black_id=$3 OR white_id=$3)
		 AND ((turn=0 AND black_id=$3) OR (turn=1 AND white_id=$3))`, boardC, gameID, userID, version)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO moves(game_id, seq, board_c)
		 SELECT $1, COALESCE(MAX(seq),0)+1, $2 FROM moves WHERE game_id=$1`, gameID, boardC)
	if err != nil {
		return mapErr(err)
	}
	return tx.Commit(ctx)
}

func (s *Store) Moves(ctx context.Context, gameID, after int64, limit int) ([]Move, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, ErrConflict
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT seq, board_c, created_at FROM moves WHERE game_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3`, gameID, after, limit)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	var out []Move
	for rows.Next() {
		var m Move
		if err := rows.Scan(&m.Seq, &m.BoardC, &m.CreatedAt); err != nil {
			return nil, mapErr(err)
		}
		out = append(out, m)
	}
	return out, mapErr(rows.Err())
}

func (s *Store) AddMessage(ctx context.Context, gameID, senderID int64, ct string) error {
	tag, err := s.Pool.Exec(ctx,
		`INSERT INTO messages(game_id, sender_id, ciphertext)
		 SELECT id,$2,$3 FROM games WHERE id=$1 AND (black_id=$2 OR white_id=$2)`,
		gameID, senderID, ct)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	return nil
}

func (s *Store) Messages(ctx context.Context, gameID, after int64, limit int) ([]Message, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, ErrConflict
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id, sender_id, ciphertext, created_at FROM messages WHERE game_id=$1 AND id>$2 ORDER BY id ASC LIMIT $3`,
		gameID, after, limit)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.Ciphertext, &m.CreatedAt); err != nil {
			return nil, mapErr(err)
		}
		out = append(out, m)
	}
	return out, mapErr(rows.Err())
}
