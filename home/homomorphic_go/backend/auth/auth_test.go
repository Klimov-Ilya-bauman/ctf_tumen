package auth

import (
	"encoding/base64"
	"testing"
)

func TestRandomSessions(t *testing.T) {
	tokens := NewTokens()
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		token, err := tokens.Issue()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || len(raw) != 32 {
			t.Fatal("invalid token size")
		}
		if seen[token] {
			t.Fatal("duplicate token")
		}
		seen[token] = true
		hash, ok := HashToken(token)
		if !ok || len(hash) != 64 || hash == token {
			t.Fatal("invalid digest")
		}
	}
}

func TestRejectForgedSessions(t *testing.T) {
	for _, token := range []string{"", "1:1", base64.StdEncoding.EncodeToString([]byte("1:1")), base64.RawURLEncoding.EncodeToString(make([]byte, 31)), base64.RawURLEncoding.EncodeToString(make([]byte, 33))} {
		if _, ok := HashToken(token); ok {
			t.Fatal("accepted malformed or legacy token")
		}
	}
}
