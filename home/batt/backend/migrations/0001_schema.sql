CREATE TABLE users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_username (username)
);

CREATE TABLE games (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    mode ENUM('bot', 'pvp') NOT NULL,
    status ENUM('waiting', 'placing', 'active', 'finished') NOT NULL,
    player1_id BIGINT UNSIGNED NOT NULL,
    player2_id BIGINT UNSIGNED NULL,
    turn_user_id BIGINT UNSIGNED NOT NULL,
    winner_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    KEY idx_games_player1 (player1_id),
    KEY idx_games_player2 (player2_id),
    CONSTRAINT fk_games_player1 FOREIGN KEY (player1_id) REFERENCES users (id),
    CONSTRAINT fk_games_player2 FOREIGN KEY (player2_id) REFERENCES users (id)
);

CREATE TABLE boards (
    game_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    ships JSON NOT NULL,
    PRIMARY KEY (game_id, user_id),
    CONSTRAINT fk_boards_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE TABLE moves (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    x TINYINT UNSIGNED NOT NULL,
    y TINYINT UNSIGNED NOT NULL,
    result ENUM('miss', 'hit', 'sunk') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_moves_cell (game_id, user_id, x, y),
    CONSTRAINT fk_moves_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    text VARCHAR(500) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_chat_game_created (game_id, created_at),
    CONSTRAINT fk_chat_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE TABLE persistences (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    UNIQUE KEY uq_persistences_code (code),
    KEY idx_persistences_user (user_id),
    KEY idx_persistences_expires (expires_at),
    CONSTRAINT fk_persistences_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
