package totp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	Digits     = 6
	Period     = 30
	Skew       = 1
	SecretSize = 20
	KeySize    = 32
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func NewSecret() ([]byte, error) {
	s := make([]byte, SecretSize)
	if _, err := rand.Read(s); err != nil {
		return nil, err
	}
	return s, nil
}

func EncodeSecret(secret []byte) string {
	return b32.EncodeToString(secret)
}

func Step(t time.Time) int64 {
	return t.Unix() / Period
}

func HOTP(secret []byte, counter uint64, digits int) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	mod := uint32(1)
	for range digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, bin%mod)
}

func Code(secret []byte, step int64) string {
	if step < 0 {
		return ""
	}
	return HOTP(secret, uint64(step), Digits)
}

func ValidCodeFormat(code string) bool {
	if len(code) != Digits {
		return false
	}
	for i := 0; i < len(code); i++ {
		if code[i] < '0' || code[i] > '9' {
			return false
		}
	}
	return true
}

func Verify(secret []byte, code string, now time.Time, lastStep *int64) (int64, bool) {
	if !ValidCodeFormat(code) || len(secret) == 0 {
		return 0, false
	}
	cur := Step(now)
	var matched int64 = -1
	for s := cur - Skew; s <= cur+Skew; s++ {
		if s < 0 {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(Code(secret, s)), []byte(code)) == 1 && matched < 0 {
			matched = s
		}
	}
	if matched < 0 {
		return 0, false
	}
	if lastStep != nil && matched <= *lastStep {
		return 0, false
	}
	return matched, true
}

func URI(issuer, account string, secret []byte) string {
	label := url.PathEscape(issuer) + ":" + url.PathEscape(account)
	q := url.Values{}
	q.Set("secret", EncodeSecret(secret))
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(Digits))
	q.Set("period", fmt.Sprint(Period))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

type Cipher struct {
	aead cipher.AEAD
}

func ParseKey(s string) ([]byte, error) {
	key, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(s))
	if err != nil || len(key) != KeySize {
		return nil, fmt.Errorf("totp: key must be %d bytes in standard base64", KeySize)
	}
	return key, nil
}

func NewCipher(key []byte) (*Cipher, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("totp: key must be %d bytes", KeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Seal(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize(), c.aead.NonceSize()+len(plaintext)+c.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.aead.Seal(nonce, nonce, plaintext, aad), nil
}

var ErrDecrypt = errors.New("totp: cannot decrypt secret")

func (c *Cipher) Open(data, aad []byte) ([]byte, error) {
	ns := c.aead.NonceSize()
	if len(data) < ns+c.aead.Overhead() {
		return nil, ErrDecrypt
	}
	out, err := c.aead.Open(nil, data[:ns], data[ns:], aad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return out, nil
}

const (
	RecoveryCodeCount  = 10
	RecoveryCodeLength = 16
	recoveryCodeBytes  = 10
)

func NewRecoveryCodes() ([]string, error) {
	seen := make(map[string]bool, RecoveryCodeCount)
	out := make([]string, 0, RecoveryCodeCount)
	for len(out) < RecoveryCodeCount {
		b := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		c := b32.EncodeToString(b)
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out, nil
}

func NormalizeRecoveryCode(s string) (string, bool) {
	if len(s) != RecoveryCodeLength {
		return "", false
	}
	u := strings.ToUpper(s)
	for i := 0; i < len(u); i++ {
		c := u[i]
		if (c < 'A' || c > 'Z') && (c < '2' || c > '7') {
			return "", false
		}
	}
	return u, true
}

func HashRecoveryCode(normalized string) []byte {
	sum := sha256.Sum256([]byte(normalized))
	return sum[:]
}
