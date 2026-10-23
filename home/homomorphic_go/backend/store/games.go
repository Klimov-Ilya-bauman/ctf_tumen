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
}

type Move struct {
	Seq       int
	BoardC    []byte
	CreatedAt time.Time
}

type Message struct {
	SenderID   int64
	Ciphertext string
	CreatedAt  time.Time
}

const gameCols = `id, black_id, white_id, status, board_c, turn`

func scanGame(row pgx.Row) (Game, error) {
	var g Game
	err := row.Scan(&g.ID, &g.BlackID, &g.WhiteID, &g.Status, &g.BoardC, &g.Turn)
	return g, err
}

func (s *Store) CreateGame(ctx context.Context, blackID int64) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO games(black_id, status) VALUES($1,'waiting') RETURNING id`,
		blackID).Scan(&id)
	if err != nil {
		return 0, mapErr(err)
	}
	return id, nil
}

func (s *Store) JoinGame(ctx context.Context, gameID, whiteID int64) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE games SET white_id=$1,status='active' WHERE id=$2 AND white_id IS NULL AND status='waiting'`,
		whiteID, gameID)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	var one int
	if err := s.Pool.QueryRow(ctx, `SELECT 1 FROM games WHERE id=$1`, gameID).Scan(&one); err != nil {
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

func (s *Store) ListGames(ctx context.Context) ([]Game, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+gameCols+` FROM games ORDER BY id DESC`)
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

func (s *Store) ApplyMove(ctx context.Context, gameID int64, boardC []byte) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx,
		`UPDATE games SET board_c=$1, turn=1-turn, updated_at=now() WHERE id=$2`, boardC, gameID)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO moves(game_id, seq, board_c)
		 SELECT $1, COALESCE(MAX(seq),0)+1, $2 FROM moves WHERE game_id=$1`, gameID, boardC)
	if err != nil {
		return mapErr(err)
	}
	return tx.Commit(ctx)
}

func (s *Store) Moves(ctx context.Context, gameID int64) ([]Move, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT seq, board_c, created_at FROM moves WHERE game_id=$1 ORDER BY seq ASC`, gameID)
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
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO messages(game_id, sender_id, ciphertext) VALUES($1,$2,$3)`,
		gameID, senderID, ct)
	return mapErr(err)
}

func (s *Store) Messages(ctx context.Context, gameID int64) ([]Message, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT sender_id, ciphertext, created_at FROM messages WHERE game_id=$1 ORDER BY created_at ASC, id ASC`,
		gameID)
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.SenderID, &m.Ciphertext, &m.CreatedAt); err != nil {
			return nil, mapErr(err)
		}
		out = append(out, m)
	}
	return out, mapErr(rows.Err())
}
