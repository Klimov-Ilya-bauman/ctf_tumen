CREATE TABLE station_packets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    bot_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    payload varchar(2048) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    CONSTRAINT station_packet_payload CHECK (char_length(payload) > 0 AND octet_length(payload) <= 2048)
);
CREATE INDEX station_packets_expiry_idx ON station_packets(expires_at);

CREATE TABLE card_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id uuid NOT NULL UNIQUE REFERENCES qsl_cards(id) ON DELETE CASCADE,
    owner_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    payload varchar(2048) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    CONSTRAINT card_note_payload CHECK (char_length(payload) > 0 AND octet_length(payload) <= 2048)
);
CREATE INDEX card_notes_expiry_idx ON card_notes(expires_at);

CREATE TABLE route_packets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    recipient_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    terminal_repeater_id uuid NOT NULL,
    payload varchar(2048) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    CONSTRAINT route_packet_payload CHECK (char_length(payload) > 0 AND octet_length(payload) <= 2048)
);
CREATE INDEX route_packets_expiry_idx ON route_packets(expires_at);
