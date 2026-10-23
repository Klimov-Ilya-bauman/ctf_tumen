package auth

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"

	"golang.org/x/crypto/bcrypt"
)

func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

type Tokens struct {
	counter uint64
}

func NewTokens() *Tokens {
	return &Tokens{}
}

func (t *Tokens) Issue(userID int64) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%d:%d", userID, atomic.AddUint64(&t.counter, 1))))
}

func (t *Tokens) Parse(token string) (userID int64, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		return 0, false
	}
	s := string(raw)
	idx := strings.IndexByte(s, ':')
	if idx < 0 {
		return 0, false
	}
	uid, err := strconv.ParseInt(s[:idx], 10, 64)
	if err != nil || uid <= 0 {
		return 0, false
	}
	if _, err := strconv.ParseUint(s[idx+1:], 10, 64); err != nil {
		return 0, false
	}
	return uid, true
}
