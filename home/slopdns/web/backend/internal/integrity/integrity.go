package integrity

import (
	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/rrdata"
)

type Existing struct {
	ID    string
	Owner string
	Type  uint16
}

type Violation struct {
	Field   string
	Message string
}

func (v *Violation) Error() string {
	return v.Field + ": " + v.Message
}

func CheckAdd(apex, owner string, typ uint16, others []Existing) *Violation {
	if typ == rrdata.TypeCNAME && owner == apex {
		return &Violation{Field: "name", Message: "CNAME is not allowed at the zone apex (RFC 1034 section 3.6.2)"}
	}
	for _, e := range others {
		if e.Owner == owner {
			switch {
			case typ == rrdata.TypeCNAME:
				return &Violation{Field: "name", Message: "CNAME cannot coexist with other records at the same name (RFC 1034 section 3.6.2)"}
			case e.Type == rrdata.TypeCNAME:
				return &Violation{Field: "name", Message: "a CNAME record already exists at this name (RFC 1034 section 3.6.2)"}
			case typ == rrdata.TypeDNAME && e.Type == rrdata.TypeDNAME:
				return &Violation{Field: "name", Message: "only one DNAME record is allowed per name (RFC 6672 section 2.4)"}
			}
		}
		if typ == rrdata.TypeDNAME && dnsname.IsStrictSubdomain(e.Owner, owner) {
			return &Violation{Field: "name", Message: "DNAME cannot be placed above existing names (RFC 6672 section 2.4)"}
		}
		if e.Type == rrdata.TypeDNAME && dnsname.IsStrictSubdomain(owner, e.Owner) {
			return &Violation{Field: "name", Message: "names below a DNAME owner are not allowed (RFC 6672 section 2.4)"}
		}
	}
	return nil
}

func CheckRemove(apex string, removed Existing, remaining []Existing) *Violation {
	if removed.Type != rrdata.TypeNS || removed.Owner != apex {
		return nil
	}
	for _, e := range remaining {
		if e.Type == rrdata.TypeNS && e.Owner == apex {
			return nil
		}
	}
	return &Violation{Message: "the last NS record at the zone apex cannot be removed"}
}

func Without(list []Existing, id string) []Existing {
	out := make([]Existing, 0, len(list))
	for _, e := range list {
		if e.ID != id {
			out = append(out, e)
		}
	}
	return out
}
