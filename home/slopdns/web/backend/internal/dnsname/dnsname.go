package dnsname

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

const (
	MaxLabelLength = 63
	MaxNameLength  = 253
	Root           = "."
	Apex           = "@"
	Wildcard       = "*"
)

const (
	ReasonEmpty            = "empty"
	ReasonRoot             = "root_not_allowed"
	ReasonInvalidChars     = "invalid_characters"
	ReasonInvalidLabel     = "invalid_label"
	ReasonEmptyLabel       = "empty_label"
	ReasonLabelTooLong     = "label_too_long"
	ReasonNameTooLong      = "name_too_long"
	ReasonOutsideSuffix    = "outside_user_zone_suffix"
	ReasonOutsideZone      = "outside_zone"
	ReasonInvalidPunycode  = "invalid_punycode"
	ReasonWildcardPosition = "invalid_wildcard"
)

type Error struct {
	Reason  string
	Message string
}

func (e *Error) Error() string {
	return e.Message
}

func fail(reason, message string) *Error {
	return &Error{Reason: reason, Message: message}
}

type Policy struct {
	Underscore bool
	Wildcard   bool
	Root       bool
	Strict     bool
}

var (
	ZonePolicy     = Policy{Strict: true}
	OwnerPolicy    = Policy{Underscore: true, Wildcard: true, Strict: true}
	HostPolicy     = Policy{Underscore: true}
	HostRootPolicy = Policy{Underscore: true, Root: true}
)

var lookup = idna.New(idna.MapForLookup(), idna.BidiRule(), idna.Transitional(false))

func Parse(s string, p Policy) (string, error) {
	if s == "" {
		return "", fail(ReasonEmpty, "name is empty")
	}
	if s == Root {
		if p.Root {
			return Root, nil
		}
		return "", fail(ReasonRoot, "the root name is not allowed")
	}
	for _, r := range s {
		if unicode.IsSpace(r) || r == '\\' || unicode.IsControl(r) || r == utf8.RuneError {
			return "", fail(ReasonInvalidChars, "name contains invalid characters")
		}
	}
	body := strings.TrimSuffix(s, ".")
	labels := strings.Split(body, ".")
	out := make([]string, len(labels))
	for i, label := range labels {
		canon, err := parseLabel(label, p, i == 0)
		if err != nil {
			return "", err
		}
		out[i] = canon
	}
	name := strings.Join(out, ".")
	if len(name) > MaxNameLength {
		return "", fail(ReasonNameTooLong, "name is longer than 253 octets")
	}
	return name + ".", nil
}

func parseLabel(label string, p Policy, first bool) (string, error) {
	if label == "" {
		return "", fail(ReasonEmptyLabel, "name contains an empty label")
	}
	if label == Wildcard {
		if p.Wildcard && first {
			return Wildcard, nil
		}
		return "", fail(ReasonInvalidLabel, "wildcard label is only allowed as the leftmost label of an owner name")
	}
	ascii := isASCII(label)
	if !ascii {
		converted, err := lookup.ToASCII(label)
		if err != nil || converted == "" || strings.Contains(converted, ".") {
			return "", fail(ReasonInvalidLabel, "label is not a valid internationalized domain name")
		}
		if p.Strict {
			if err := checkULabel(converted); err != nil {
				return "", err
			}
		}
		label = converted
	}
	label = strings.ToLower(label)
	if len(label) > MaxLabelLength {
		return "", fail(ReasonLabelTooLong, "label is longer than 63 octets")
	}
	for i := 0; i < len(label); i++ {
		c := label[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-':
		case c == '_' && p.Underscore:
		default:
			return "", fail(ReasonInvalidLabel, "label contains a character that is not allowed")
		}
	}
	if label[0] == '-' || label[len(label)-1] == '-' {
		return "", fail(ReasonInvalidLabel, "label must not start or end with a hyphen")
	}
	if ascii && strings.HasPrefix(label, "xn--") {
		if _, err := lookup.ToUnicode(label); err != nil {
			return "", fail(ReasonInvalidPunycode, "label is not valid punycode")
		}
		if p.Strict {
			if err := checkULabel(label); err != nil {
				return "", err
			}
		}
	}
	return label, nil
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func IsSubdomain(name, parent string) bool {
	if parent == Root {
		return true
	}
	return name == parent || strings.HasSuffix(name, "."+parent)
}

func IsStrictSubdomain(name, parent string) bool {
	return name != parent && IsSubdomain(name, parent)
}

func ParseUserZone(s, suffix string) (string, error) {
	name, err := Parse(s, ZonePolicy)
	if err != nil {
		return "", err
	}
	if !IsStrictSubdomain(name, suffix) {
		return "", fail(ReasonOutsideSuffix, "zone name must be a subdomain of "+strings.TrimSuffix(suffix, "."))
	}
	return name, nil
}

func ParseOwner(s, apex string) (string, error) {
	if s == Apex {
		return apex, nil
	}
	if s == "" {
		return "", fail(ReasonEmpty, "name is empty")
	}
	full := s
	if !strings.HasSuffix(s, ".") {
		full = s + "." + apex
		if apex == Root {
			full = s + "."
		}
	} else if s == Root {
		full = Root
	}
	name, err := Parse(full, Policy{Underscore: true, Wildcard: true, Root: apex == Root, Strict: true})
	if err != nil {
		return "", err
	}
	if !IsSubdomain(name, apex) {
		return "", fail(ReasonOutsideZone, "name must be equal to or below the zone apex "+apex)
	}
	return name, nil
}

func ParseHost(s string, allowRoot bool) (string, error) {
	if allowRoot {
		return Parse(s, HostRootPolicy)
	}
	return Parse(s, HostPolicy)
}

func Ancestors(name, apex string) []string {
	var out []string
	cur := name
	for cur != apex && cur != Root {
		i := strings.IndexByte(cur, '.')
		if i < 0 || i == len(cur)-1 {
			cur = Root
		} else {
			cur = cur[i+1:]
		}
		if !IsSubdomain(cur, apex) {
			break
		}
		out = append(out, cur)
	}
	return out
}

func NormalizeSuffix(s string) (string, error) {
	return Parse(s, ZonePolicy)
}
