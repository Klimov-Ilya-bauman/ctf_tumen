package core

import (
	"regexp"
	"unicode/utf8"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/password"
	"slopdns/web/iam/internal/token"
	"slopdns/web/iam/internal/totp"
	"slopdns/web/pkg/rbac"
)

var (
	usernameRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,31}$`)
	saNameRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,62}$`)
	tokenNameRe = regexp.MustCompile(`^[A-Za-z0-9 ._:@-]{1,64}$`)
)

const (
	MaxDescription  = 256
	MinTokenDays    = 1
	MaxTokenDays    = 3650
	MaxPageLimit    = 500
	MaxPageOffset   = 1000000
	DefaultPageSize = 100
	MaxLookup       = 1000
)

func ValidUsername(s string) bool {
	return usernameRe.MatchString(s)
}

func ValidServiceAccountName(s string) bool {
	return saNameRe.MatchString(s)
}

func ValidTokenName(s string) bool {
	return tokenNameRe.MatchString(s)
}

func ValidDescription(s string) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > MaxDescription {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func checkUsername(field, s string) error {
	if !ValidUsername(s) {
		return invalid(field, "must be 3-32 characters of a-z, 0-9 and '-', starting with a letter or digit")
	}
	return nil
}

func checkPassword(field, s string) error {
	if !password.ValidLength(s) {
		return invalid(field, "must be 12-128 characters")
	}
	return nil
}

func checkTOTPCode(field, s string) error {
	if !totp.ValidCodeFormat(s) {
		return invalid(field, "must be 6 digits")
	}
	return nil
}

func checkRecoveryCode(field, s string) (string, error) {
	n, ok := totp.NormalizeRecoveryCode(s)
	if !ok {
		return "", invalid(field, "must be 16 base32 characters")
	}
	return n, nil
}

func ParseID(field, s string) (uuid.UUID, error) {
	id, err := token.ParseID(s)
	if err != nil {
		return uuid.UUID{}, invalid(field, "must be a lower-case canonical UUID")
	}
	return id, nil
}

func ParseResourceType(field, s string) (rbac.ResourceType, error) {
	rt := rbac.ResourceType(s)
	if !rt.Valid() {
		return "", invalid(field, "must be one of org, zone, service_account")
	}
	return rt, nil
}

func ParsePrincipalType(field, s string) (rbac.PrincipalType, error) {
	pt := rbac.PrincipalType(s)
	if !pt.Valid() {
		return "", invalid(field, "must be one of user, service_account")
	}
	return pt, nil
}

func ParseGrantableRole(field, s string) (rbac.Role, error) {
	r, ok := rbac.ParseRole(s)
	if !ok || !rbac.Grantable(r) {
		return rbac.RoleNone, invalid(field, "must be one of admin, editor, reader")
	}
	return r, nil
}
