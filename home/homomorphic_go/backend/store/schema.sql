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

-- Existing legacy sessions have NULL expiry and are rejected on lookup.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE games ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS black_pubkey bytea;
ALTER TABLE games ADD COLUMN IF NOT EXISTS white_pubkey bytea;
ALTER TABLE games ADD COLUMN IF NOT EXISTS keys_frozen boolean NOT NULL DEFAULT false;
-- Legacy rows can only snapshot the currently stored keys, not recover lost keys.
UPDATE games g SET black_pubkey=u.pubkey FROM users u
 WHERE NOT g.keys_frozen AND u.id=g.black_id;
UPDATE games g SET white_pubkey=u.pubkey FROM users u
 WHERE NOT g.keys_frozen AND u.id=g.white_id;
UPDATE games SET keys_frozen=true WHERE NOT keys_frozen;

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

CREATE INDEX IF NOT EXISTS messages_game_id_id ON messages(game_id, id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
