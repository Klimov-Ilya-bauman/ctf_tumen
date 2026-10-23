package assertion

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	Header     = "X-SlopDNS-Assertion"
	Audience   = "slopdns-internal"
	DefaultTTL = 15 * time.Second
	MaxTTL     = DefaultTTL + 5*time.Second
	MaxLength  = 4096
)

const DefaultLeeway = 5 * time.Second

type PrincipalType string

const (
	PrincipalUser           PrincipalType = "user"
	PrincipalServiceAccount PrincipalType = "service_account"
)

func (p PrincipalType) Valid() bool {
	return p == PrincipalUser || p == PrincipalServiceAccount
}

var (
	ErrMissing   = errors.New("assertion missing")
	ErrMalformed = errors.New("assertion malformed")
	ErrSignature = errors.New("assertion signature invalid")
	ErrExpired   = errors.New("assertion expired")
	ErrNotYet    = errors.New("assertion issued in the future")
	ErrClaims    = errors.New("assertion claims invalid")
	ErrKeyID     = fmt.Errorf("%w: key id unknown", ErrSignature)
)

const maxKeyIDLength = 64

type Subject struct {
	ID           string
	Type         PrincipalType
	OrgID        string
	TokenID      string
	AuthzVersion int64
	KeyID        string
	IssuedAt     time.Time
	ExpiresAt    time.Time
}

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ,omitempty"`
	Kid string `json:"kid,omitempty"`
}

type claims struct {
	Sub   string        `json:"sub"`
	PType PrincipalType `json:"ptype"`
	Org   string        `json:"org,omitempty"`
	Av    *int64        `json:"av"`
	Iat   int64         `json:"iat"`
	Exp   int64         `json:"exp"`
	Jti   string        `json:"jti"`
	Aud   string        `json:"aud"`
}

func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func ValidKeyID(kid string) bool {
	if kid == "" || len(kid) > maxKeyIDLength {
		return false
	}
	for i := 0; i < len(kid); i++ {
		c := kid[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

func encodeHeader(kid string) (string, error) {
	b, err := json.Marshal(header{Alg: "EdDSA", Typ: "JWT", Kid: kid})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func validateSubject(id string, ptype PrincipalType, org string) error {
	if !isUUID(id) {
		return fmt.Errorf("%w: sub must be a UUID", ErrClaims)
	}
	if !ptype.Valid() {
		return fmt.Errorf("%w: unknown ptype %q", ErrClaims, ptype)
	}
	switch ptype {
	case PrincipalServiceAccount:
		if !isUUID(org) {
			return fmt.Errorf("%w: org is required for service accounts", ErrClaims)
		}
	case PrincipalUser:
		if org != "" {
			return fmt.Errorf("%w: org must be empty for users", ErrClaims)
		}
	}
	return nil
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	u, err := uuid.Parse(s)
	return err == nil && u.String() == s
}

type Issuer struct {
	key    ed25519.PrivateKey
	kid    string
	header string
	ttl    time.Duration
	now    func() time.Time
}

func NewIssuer(key ed25519.PrivateKey, ttl time.Duration) (*Issuer, error) {
	if len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("assertion: invalid Ed25519 private key")
	}
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("assertion: invalid Ed25519 private key")
	}
	return NewIssuerWithKeyID(key, KeyID(pub), ttl)
}

func NewIssuerWithKeyID(key ed25519.PrivateKey, kid string, ttl time.Duration) (*Issuer, error) {
	if len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("assertion: invalid Ed25519 private key")
	}
	if !ValidKeyID(kid) {
		return nil, errors.New("assertion: invalid key id")
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if ttl > MaxTTL {
		return nil, fmt.Errorf("assertion: ttl must not exceed %s", MaxTTL)
	}
	h, err := encodeHeader(kid)
	if err != nil {
		return nil, err
	}
	return &Issuer{key: key, kid: kid, header: h, ttl: ttl, now: time.Now}, nil
}

func (i *Issuer) KeyID() string {
	return i.kid
}

func (i *Issuer) TTL() time.Duration {
	return i.ttl
}

func (i *Issuer) SetClock(now func() time.Time) {
	i.now = now
}

func (i *Issuer) Issue(id string, ptype PrincipalType, orgID string) (string, time.Time, error) {
	return i.IssueVersioned(id, ptype, orgID, 0)
}

func (i *Issuer) IssueVersioned(id string, ptype PrincipalType, orgID string, authzVersion int64) (string, time.Time, error) {
	if err := validateSubject(id, ptype, orgID); err != nil {
		return "", time.Time{}, err
	}
	if authzVersion < 0 {
		return "", time.Time{}, fmt.Errorf("%w: av must not be negative", ErrClaims)
	}
	jti, err := uuid.NewV7()
	if err != nil {
		return "", time.Time{}, err
	}
	now := i.now().UTC().Truncate(time.Second)
	exp := now.Add(i.ttl)
	payload, err := json.Marshal(claims{
		Sub:   id,
		PType: ptype,
		Org:   orgID,
		Av:    &authzVersion,
		Iat:   now.Unix(),
		Exp:   exp.Unix(),
		Jti:   jti.String(),
		Aud:   Audience,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	signingInput := i.header + "." + base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(i.key, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), exp, nil
}

type Verifier struct {
	keys   map[string]ed25519.PublicKey
	leeway time.Duration
	now    func() time.Time
}

func NewVerifier(key ed25519.PublicKey) (*Verifier, error) {
	if len(key) != ed25519.PublicKeySize {
		return nil, errors.New("assertion: invalid Ed25519 public key")
	}
	return NewKeySetVerifier(map[string]ed25519.PublicKey{KeyID(key): key})
}

func NewKeySetVerifier(keys map[string]ed25519.PublicKey) (*Verifier, error) {
	if len(keys) == 0 {
		return nil, errors.New("assertion: empty key set")
	}
	set := make(map[string]ed25519.PublicKey, len(keys))
	for kid, key := range keys {
		if !ValidKeyID(kid) {
			return nil, fmt.Errorf("assertion: invalid key id %q", kid)
		}
		if len(key) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("assertion: invalid Ed25519 public key for %q", kid)
		}
		set[kid] = append(ed25519.PublicKey(nil), key...)
	}
	return &Verifier{keys: set, leeway: DefaultLeeway, now: time.Now}, nil
}

func (v *Verifier) key(kid string) (ed25519.PublicKey, string, error) {
	if kid == "" {
		return nil, "", fmt.Errorf("%w: kid is required", ErrKeyID)
	}
	k, ok := v.keys[kid]
	if !ok {
		return nil, "", ErrKeyID
	}
	return k, kid, nil
}

func (v *Verifier) SetClock(now func() time.Time) {
	v.now = now
}

func (v *Verifier) SetLeeway(d time.Duration) {
	v.leeway = d
}

func decodeStrict(data []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data")
	}
	return nil
}

func validTokenChars(token string) bool {
	for i := 0; i < len(token); i++ {
		c := token[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' && c != '.' {
			return false
		}
	}
	return true
}

func (v *Verifier) Verify(token string) (Subject, error) {
	if token == "" {
		return Subject{}, ErrMissing
	}
	if len(token) > MaxLength {
		return Subject{}, fmt.Errorf("%w: too long", ErrMalformed)
	}
	if !validTokenChars(token) {
		return Subject{}, fmt.Errorf("%w: invalid characters", ErrMalformed)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Subject{}, fmt.Errorf("%w: expected 3 segments", ErrMalformed)
	}
	headerJSON, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		return Subject{}, fmt.Errorf("%w: header encoding", ErrMalformed)
	}
	var h header
	if err := decodeStrict(headerJSON, &h); err != nil {
		return Subject{}, fmt.Errorf("%w: header", ErrMalformed)
	}
	if h.Alg != "EdDSA" || (h.Typ != "" && h.Typ != "JWT") {
		return Subject{}, fmt.Errorf("%w: unsupported algorithm", ErrMalformed)
	}
	if h.Kid != "" && !ValidKeyID(h.Kid) {
		return Subject{}, fmt.Errorf("%w: kid", ErrMalformed)
	}
	key, kid, err := v.key(h.Kid)
	if err != nil {
		return Subject{}, err
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return Subject{}, ErrSignature
	}
	if !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return Subject{}, ErrSignature
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil {
		return Subject{}, fmt.Errorf("%w: payload encoding", ErrMalformed)
	}
	var c claims
	if err := decodeStrict(payload, &c); err != nil {
		return Subject{}, fmt.Errorf("%w: payload", ErrMalformed)
	}
	if c.Aud != Audience {
		return Subject{}, fmt.Errorf("%w: audience", ErrClaims)
	}
	if !isUUID(c.Jti) {
		return Subject{}, fmt.Errorf("%w: jti must be a UUID", ErrClaims)
	}
	if err := validateSubject(c.Sub, c.PType, c.Org); err != nil {
		return Subject{}, err
	}
	if c.Av == nil || *c.Av < 0 {
		return Subject{}, fmt.Errorf("%w: av must be a non-negative integer", ErrClaims)
	}
	av := *c.Av
	if c.Iat <= 0 || c.Exp <= c.Iat || c.Exp-c.Iat > int64(MaxTTL/time.Second) {
		return Subject{}, fmt.Errorf("%w: lifetime", ErrClaims)
	}
	now := v.now()
	iat := time.Unix(c.Iat, 0).UTC()
	exp := time.Unix(c.Exp, 0).UTC()
	if !now.Before(exp.Add(v.leeway)) {
		return Subject{}, ErrExpired
	}
	if iat.After(now.Add(v.leeway)) {
		return Subject{}, ErrNotYet
	}
	return Subject{ID: c.Sub, Type: c.PType, OrgID: c.Org, TokenID: c.Jti, AuthzVersion: av, KeyID: kid, IssuedAt: iat, ExpiresAt: exp}, nil
}
