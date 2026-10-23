package password

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	MinLength = 12
	MaxLength = 128
)

type Params struct {
	Memory  uint32
	Time    uint32
	Threads uint8
	SaltLen uint32
	KeyLen  uint32
}

var Default = Params{Memory: 64 * 1024, Time: 3, Threads: 2, SaltLen: 16, KeyLen: 32}

const (
	maxMemory  = 1024 * 1024
	maxTime    = 32
	maxSaltLen = 64
	maxKeyLen  = 128
)

var (
	ErrInvalidHash = errors.New("password: invalid hash")
	ErrTooLong     = errors.New("password: too long")
	ErrBusy        = errors.New("password: hashing pool is busy")
)

const DefaultQueueTimeout = 2 * time.Second

type Hasher struct {
	params       Params
	sem          chan struct{}
	queueTimeout time.Duration
	dummy        string
}

func NewHasher(p Params, concurrency int, queueTimeout time.Duration) (*Hasher, error) {
	if err := p.validate(); err != nil {
		return nil, err
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if queueTimeout <= 0 {
		queueTimeout = DefaultQueueTimeout
	}
	h := &Hasher{params: p, sem: make(chan struct{}, concurrency), queueTimeout: queueTimeout}
	dummy, err := h.Hash(context.Background(), "slopdns-dummy-password")
	if err != nil {
		return nil, err
	}
	h.dummy = dummy
	return h, nil
}

func (p Params) validate() error {
	switch {
	case p.Memory < 8 || p.Memory > maxMemory:
		return errors.New("password: memory out of range")
	case p.Time < 1 || p.Time > maxTime:
		return errors.New("password: time out of range")
	case p.Threads < 1:
		return errors.New("password: threads out of range")
	case p.SaltLen < 8 || p.SaltLen > maxSaltLen:
		return errors.New("password: salt length out of range")
	case p.KeyLen < 16 || p.KeyLen > maxKeyLen:
		return errors.New("password: key length out of range")
	}
	return nil
}

func byteLen(b []byte) uint32 {
	n := len(b)
	if n < 0 || n > maxKeyLen {
		return maxKeyLen + 1
	}
	return uint32(n)
}

func ValidLength(pw string) bool {
	if !utf8.ValidString(pw) {
		return false
	}
	n := utf8.RuneCountInString(pw)
	return n >= MinLength && n <= MaxLength
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.sem <- struct{}{}:
		return nil
	default:
	}
	timer := time.NewTimer(h.queueTimeout)
	defer timer.Stop()
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-timer.C:
		return ErrBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Hasher) release() {
	<-h.sem
}

func (h *Hasher) Hold(ctx context.Context) (func(), error) {
	if err := h.acquire(ctx); err != nil {
		return nil, err
	}
	return h.release, nil
}

func (h *Hasher) Hash(ctx context.Context, pw string) (string, error) {
	if len(pw) > MaxLength*utf8.UTFMax {
		return "", ErrTooLong
	}
	salt := make([]byte, h.params.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, h.params.Time, h.params.Memory, h.params.Threads, h.params.KeyLen)
	h.release()
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, h.params.Memory, h.params.Time, h.params.Threads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func (h *Hasher) Verify(ctx context.Context, pw, encoded string) (bool, error) {
	p, salt, key, err := Decode(encoded)
	if err != nil {
		return false, err
	}
	if len(pw) > MaxLength*utf8.UTFMax {
		return false, nil
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pw), salt, p.Time, p.Memory, p.Threads, byteLen(key))
	h.release()
	return subtle.ConstantTimeCompare(got, key) == 1, nil
}

func (h *Hasher) VerifyDummy(ctx context.Context, pw string) error {
	_, err := h.Verify(ctx, pw, h.dummy)
	return err
}

func (h *Hasher) NeedsRehash(encoded string) bool {
	p, salt, key, err := Decode(encoded)
	if err != nil {
		return true
	}
	return p.Memory != h.params.Memory || p.Time != h.params.Time || p.Threads != h.params.Threads || byteLen(salt) != h.params.SaltLen || byteLen(key) != h.params.KeyLen
}

func Decode(encoded string) (Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version || parts[2] != fmt.Sprintf("v=%d", version) {
		return Params{}, nil, nil, ErrInvalidHash
	}
	var p Params
	var threads uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &threads); err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	if parts[3] != fmt.Sprintf("m=%d,t=%d,p=%d", p.Memory, p.Time, threads) || threads < 1 || threads > 255 {
		return Params{}, nil, nil, ErrInvalidHash
	}
	p.Threads = uint8(threads)
	enc := base64.RawStdEncoding.Strict()
	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	key, err := enc.DecodeString(parts[5])
	if err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	p.SaltLen = byteLen(salt)
	p.KeyLen = byteLen(key)
	if err := p.validate(); err != nil {
		return Params{}, nil, nil, ErrInvalidHash
	}
	return p, salt, key, nil
}
