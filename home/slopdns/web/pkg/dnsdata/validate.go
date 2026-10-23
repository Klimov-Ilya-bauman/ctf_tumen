package dnsdata

import (
	"errors"
	"fmt"
	"strings"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"
)

const (
	TypeCNAME uint16 = 5
	TypePTR   uint16 = 12
	TypeMX    uint16 = 15
	TypeSRV   uint16 = 33
	TypeDNAME uint16 = 39
	TypeOPT   uint16 = 41
	maxRdata         = 65535
)

var ErrInvalidData = errors.New("dnsdata: invalid sync data")

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalidData}, args...)...)
}

func canonicalChar(c byte) bool {
	return c >= 0x21 && c <= 0x7e && c != '.' && c != '\\' && (c < 'A' || c > 'Z')
}

func ValidName(name string) bool {
	if name == "." {
		return true
	}
	if name == "" || !strings.HasSuffix(name, ".") {
		return false
	}
	wire := 1
	start := 0
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			n := i - start
			if n == 0 || n > maxLabel {
				return false
			}
			wire += n + 1
			start = i + 1
			continue
		}
		if !canonicalChar(name[i]) {
			return false
		}
	}
	return wire <= maxName
}

func InZone(owner, apex string) bool {
	if apex == "." || owner == apex {
		return true
	}
	return strings.HasSuffix(owner, "."+apex)
}

func ValidType(t uint32) bool {
	return t != 0 && t <= 0xffff && t != uint32(TypeOPT) && (t < 128 || t > 255)
}

func uncompressedNameLen(b []byte) (int, bool) {
	pos := 0
	for {
		if pos >= len(b) {
			return 0, false
		}
		n := int(b[pos])
		if n&0xc0 != 0 {
			return 0, false
		}
		pos++
		if n == 0 {
			return pos, pos <= maxName
		}
		pos += n
		if pos > maxName {
			return 0, false
		}
	}
}

func nameOffset(t uint32) (int, bool) {
	switch t {
	case uint32(TypeNS), uint32(TypeCNAME), uint32(TypeDNAME), uint32(TypePTR):
		return 0, true
	case uint32(TypeMX):
		return 2, true
	case uint32(TypeSRV):
		return 6, true
	}
	return 0, false
}

func validRdata(t uint32, rd []byte) bool {
	if t == uint32(TypeSOA) {
		a, ok := uncompressedNameLen(rd)
		if !ok {
			return false
		}
		b, ok := uncompressedNameLen(rd[a:])
		return ok && a+b+20 == len(rd)
	}
	off, ok := nameOffset(t)
	if !ok {
		return true
	}
	if len(rd) < off {
		return false
	}
	n, ok := uncompressedNameLen(rd[off:])
	return ok && off+n == len(rd)
}

func ValidateRRSet(apex string, set *syncv1.RRSet) error {
	if set == nil {
		return invalidf("missing rrset")
	}
	if !ValidName(set.GetOwner()) {
		return invalidf("owner %q is not a canonical name", set.GetOwner())
	}
	if !InZone(set.GetOwner(), apex) {
		return invalidf("owner %q is outside zone %q", set.GetOwner(), apex)
	}
	if set.GetRrClass() != uint32(ClassIN) {
		return invalidf("%s class %d is not IN", set.GetOwner(), set.GetRrClass())
	}
	if !ValidType(set.GetType()) {
		return invalidf("%s type %d is not allowed", set.GetOwner(), set.GetType())
	}
	if len(set.GetRdata()) == 0 {
		return invalidf("%s type %d has no rdata", set.GetOwner(), set.GetType())
	}
	distinct := map[string]bool{}
	for _, rd := range set.GetRdata() {
		if len(rd) > maxRdata {
			return invalidf("%s type %d rdata is longer than 65535 octets", set.GetOwner(), set.GetType())
		}
		if !validRdata(set.GetType(), rd) {
			return invalidf("%s type %d rdata is malformed", set.GetOwner(), set.GetType())
		}
		distinct[string(rd)] = true
	}
	switch set.GetType() {
	case uint32(TypeCNAME), uint32(TypeDNAME), uint32(TypeSOA):
		if len(distinct) != 1 {
			return invalidf("%s type %d must have exactly one rdata", set.GetOwner(), set.GetType())
		}
	}
	return nil
}

type setKey struct {
	owner string
	typ   uint32
	class uint32
}

func ValidateZone(z *syncv1.Zone) error {
	if z == nil || !ValidName(z.GetApex()) {
		return invalidf("zone apex %q is not a canonical name", z.GetApex())
	}
	seen := map[setKey]bool{}
	for _, set := range z.GetRrsets() {
		if err := ValidateRRSet(z.GetApex(), set); err != nil {
			return err
		}
		k := setKey{set.GetOwner(), set.GetType(), set.GetRrClass()}
		if seen[k] {
			return invalidf("duplicate rrset %s type %d in zone %s", k.owner, k.typ, z.GetApex())
		}
		seen[k] = true
	}
	return nil
}

func SanitizeZone(z *syncv1.Zone) (*syncv1.Zone, []error) {
	if z == nil || !ValidName(z.GetApex()) {
		return nil, []error{invalidf("zone apex %q is not a canonical name", z.GetApex())}
	}
	var problems []error
	out := &syncv1.Zone{Apex: z.GetApex()}
	seen := map[setKey]bool{}
	for _, set := range z.GetRrsets() {
		if err := ValidateRRSet(z.GetApex(), set); err != nil {
			problems = append(problems, fmt.Errorf("zone %s: %w", z.GetApex(), err))
			continue
		}
		k := setKey{set.GetOwner(), set.GetType(), set.GetRrClass()}
		if seen[k] {
			problems = append(problems, invalidf("duplicate rrset %s type %d in zone %s", k.owner, k.typ, z.GetApex()))
			continue
		}
		seen[k] = true
		out.Rrsets = append(out.Rrsets, set)
	}
	return out, problems
}

func SanitizeZones(zones []*syncv1.Zone) ([]*syncv1.Zone, []error) {
	var problems []error
	out := make([]*syncv1.Zone, 0, len(zones))
	seen := map[string]bool{}
	for _, z := range zones {
		clean, errs := SanitizeZone(z)
		problems = append(problems, errs...)
		if clean == nil {
			continue
		}
		if seen[clean.GetApex()] {
			problems = append(problems, invalidf("duplicate zone %s", clean.GetApex()))
			continue
		}
		seen[clean.GetApex()] = true
		out = append(out, clean)
	}
	return out, problems
}

func SanitizeOps(ops []*syncv1.Op) ([]*syncv1.Op, []error) {
	var problems []error
	out := make([]*syncv1.Op, 0, len(ops))
	for _, op := range ops {
		switch v := op.GetOp().(type) {
		case *syncv1.Op_PutZone:
			clean, errs := SanitizeZone(v.PutZone)
			problems = append(problems, errs...)
			if clean != nil {
				out = append(out, PutZone(clean))
			}
		case *syncv1.Op_DeleteZone:
			if !ValidName(v.DeleteZone) {
				problems = append(problems, invalidf("delete_zone apex %q is not a canonical name", v.DeleteZone))
				continue
			}
			out = append(out, op)
		case *syncv1.Op_PutRrset:
			apex := v.PutRrset.GetApex()
			set := v.PutRrset.GetRrset()
			if !ValidName(apex) || set == nil || !ValidName(set.GetOwner()) || !InZone(set.GetOwner(), apex) {
				problems = append(problems, invalidf("put_rrset with an invalid zone, owner or empty rrset (zone %q)", apex))
				continue
			}
			if err := ValidateRRSet(apex, set); err != nil {
				problems = append(problems, fmt.Errorf("put_rrset replaced by delete_rrset: %w", err))
				out = append(out, &syncv1.Op{Op: &syncv1.Op_DeleteRrset{DeleteRrset: &syncv1.RRSetKey{Apex: apex, Owner: set.GetOwner(), Type: set.GetType(), RrClass: set.GetRrClass()}}})
				continue
			}
			out = append(out, op)
		case *syncv1.Op_DeleteRrset:
			k := v.DeleteRrset
			if k == nil || !ValidName(k.GetApex()) || !ValidName(k.GetOwner()) {
				problems = append(problems, invalidf("delete_rrset with an invalid zone or owner"))
				continue
			}
			out = append(out, op)
		default:
			problems = append(problems, invalidf("op without a variant"))
		}
	}
	return out, problems
}
