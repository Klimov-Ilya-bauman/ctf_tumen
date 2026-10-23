CREATE TABLE IF NOT EXISTS users (
	id bigserial PRIMARY KEY,
	username text UNIQUE NOT NULL,
	pass_hash text NOT NULL,
	pubkey bytea,
	created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
	token text PRIMARY KEY,
	user_id bigint NOT NULL REFERENCES users(id),
	created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
	id bigserial PRIMARY KEY,
	black_id bigint NOT NULL REFERENCES users(id),
	white_id bigint REFERENCES users(id),
	status text NOT NULL,
	board_c bytea,
	turn smallint NOT NULL DEFAULT 0,
	created_at timestamptz DEFAULT now(),
	updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moves (
	id bigserial PRIMARY KEY,
	game_id bigint NOT NULL REFERENCES games(id),
	seq int NOT NULL,
	board_c bytea NOT NULL,
	created_at timestamptz DEFAULT now(),
	UNIQUE (game_id, seq)
);

CREATE TABLE IF NOT EXISTS messages (
	id bigserial PRIMARY KEY,
	game_id bigint NOT NULL REFERENCES games(id),
	sender_id bigint NOT NULL REFERENCES users(id),
	ciphertext text NOT NULL,
	created_at timestamptz DEFAULT now()
);
