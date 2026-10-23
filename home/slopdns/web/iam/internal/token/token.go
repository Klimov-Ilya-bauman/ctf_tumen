package token

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math/big"
	"strings"

	"github.com/google/uuid"
)

type Kind string

const (
	KindSession        Kind = "sdses"
	KindUserAPI        Kind = "sdpat"
	KindServiceAccount Kind = "sdsat"
	KindMFA            Kind = "sdmfa"
)

const (
	SecretBytes  = 32
	SecretLength = 43
	idLength     = 36
	alphabet     = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	MaxLength    = 5 + 1 + idLength + 1 + SecretLength
)

var ErrMalformed = errors.New("token: malformed")

type Token struct {
	Kind   Kind
	ID     uuid.UUID
	Secret string
}

func (k Kind) Valid() bool {
	switch k {
	case KindSession, KindUserAPI, KindServiceAccount, KindMFA:
		return true
	}
	return false
}

func (t Token) String() string {
	return string(t.Kind) + "_" + t.ID.String() + "_" + t.Secret
}

func (t Token) Hash() []byte {
	return HashSecret(t.Secret)
}

func HashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func Equal(storedHash []byte, secret string) bool {
	return len(storedHash) == sha256.Size && subtle.ConstantTimeCompare(storedHash, HashSecret(secret)) == 1
}

func New(kind Kind) (Token, error) {
	if !kind.Valid() {
		return Token{}, errors.New("token: unknown kind")
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Token{}, err
	}
	secret, err := NewSecret()
	if err != nil {
		return Token{}, err
	}
	return Token{Kind: kind, ID: id, Secret: secret}, nil
}

func NewSecret() (string, error) {
	b := make([]byte, SecretBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return EncodeBase62(b), nil
}

func EncodeBase62(b []byte) string {
	n := new(big.Int).SetBytes(b)
	base := big.NewInt(int64(len(alphabet)))
	mod := new(big.Int)
	out := make([]byte, 0, SecretLength)
	for n.Sign() > 0 {
		n.QuoRem(n, base, mod)
		out = append(out, alphabet[mod.Int64()])
	}
	for len(out) < SecretLength {
		out = append(out, '0')
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func isBase62(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

func Parse(s string) (Token, error) {
	if len(s) != MaxLength {
		return Token{}, ErrMalformed
	}
	kind := Kind(s[:5])
	if !kind.Valid() || s[5] != '_' || s[6+idLength] != '_' {
		return Token{}, ErrMalformed
	}
	idPart := s[6 : 6+idLength]
	secret := s[7+idLength:]
	id, err := ParseID(idPart)
	if err != nil {
		return Token{}, ErrMalformed
	}
	if len(secret) != SecretLength || !isBase62(secret) {
		return Token{}, ErrMalformed
	}
	return Token{Kind: kind, ID: id, Secret: secret}, nil
}

func ParseKind(s string, kind Kind) (Token, error) {
	t, err := Parse(s)
	if err != nil {
		return Token{}, err
	}
	if t.Kind != kind {
		return Token{}, ErrMalformed
	}
	return t, nil
}

func ParseID(s string) (uuid.UUID, error) {
	if len(s) != idLength || strings.ToLower(s) != s {
		return uuid.UUID{}, ErrMalformed
	}
	id, err := uuid.Parse(s)
	if err != nil || id.String() != s {
		return uuid.UUID{}, ErrMalformed
	}
	return id, nil
}
