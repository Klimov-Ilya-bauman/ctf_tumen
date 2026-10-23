package dnsdata

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"sort"
	"strings"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"
)

const (
	ClassIN  uint16 = 1
	TypeSOA  uint16 = 6
	TypeNS   uint16 = 2
	maxLabel        = 63
	maxName         = 255
)

var ErrBadName = errors.New("dnsdata: invalid canonical domain name")

type SOA struct {
	MName   string
	RName   string
	Serial  uint32
	Refresh uint32
	Retry   uint32
	Expire  uint32
	Minimum uint32
}

type RR struct {
	Owner string
	Type  uint16
	TTL   uint32
	Wire  []byte
}

type Zone struct {
	Apex   string
	SOA    SOA
	SOATTL uint32
}

func NextSerial(s uint32) uint32 {
	return s + 1
}

func AppendName(dst []byte, name string) ([]byte, error) {
	if name == "." {
		return append(dst, 0), nil
	}
	if name == "" || !strings.HasSuffix(name, ".") {
		return nil, ErrBadName
	}
	start := len(dst)
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if label == "" || len(label) > maxLabel || strings.ContainsRune(label, '\\') {
			return nil, ErrBadName
		}
		dst = append(dst, labelLen(label))
		dst = append(dst, label...)
	}
	dst = append(dst, 0)
	if len(dst)-start > maxName {
		return nil, ErrBadName
	}
	return dst, nil
}

func labelLen(label string) byte {
	n := len(label)
	if n < 0 || n > math.MaxUint8 {
		return 0
	}
	return byte(n)
}

func u32(n int) uint32 {
	if n < 0 || uint64(n) > math.MaxUint32 {
		return 0
	}
	return uint32(n)
}

func SOAWire(s SOA) ([]byte, error) {
	out, err := AppendName(nil, s.MName)
	if err != nil {
		return nil, err
	}
	if out, err = AppendName(out, s.RName); err != nil {
		return nil, err
	}
	for _, v := range []uint32{s.Serial, s.Refresh, s.Retry, s.Expire, s.Minimum} {
		out = binary.BigEndian.AppendUint32(out, v)
	}
	return out, nil
}

func SOARRSet(z Zone) (*syncv1.RRSet, error) {
	wire, err := SOAWire(z.SOA)
	if err != nil {
		return nil, err
	}
	return &syncv1.RRSet{Owner: z.Apex, Type: uint32(TypeSOA), RrClass: uint32(ClassIN), Ttl: z.SOATTL, Rdata: [][]byte{wire}}, nil
}

type rrsetKey struct {
	owner string
	typ   uint16
}

func RRSets(rrs []RR) []*syncv1.RRSet {
	groups := map[rrsetKey]*syncv1.RRSet{}
	var keys []rrsetKey
	for _, rr := range rrs {
		k := rrsetKey{rr.Owner, rr.Type}
		set, ok := groups[k]
		if !ok {
			set = &syncv1.RRSet{Owner: rr.Owner, Type: uint32(rr.Type), RrClass: uint32(ClassIN), Ttl: rr.TTL}
			groups[k] = set
			keys = append(keys, k)
		}
		if rr.TTL < set.Ttl {
			set.Ttl = rr.TTL
		}
		set.Rdata = append(set.Rdata, append([]byte(nil), rr.Wire...))
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].owner != keys[j].owner {
			return keys[i].owner < keys[j].owner
		}
		return keys[i].typ < keys[j].typ
	})
	out := make([]*syncv1.RRSet, 0, len(keys))
	for _, k := range keys {
		set := groups[k]
		sort.Slice(set.Rdata, func(i, j int) bool { return bytes.Compare(set.Rdata[i], set.Rdata[j]) < 0 })
		out = append(out, set)
	}
	return out
}

func ZoneMessage(z Zone, rrs []RR) (*syncv1.Zone, error) {
	soa, err := SOARRSet(z)
	if err != nil {
		return nil, err
	}
	sets := append([]*syncv1.RRSet{soa}, RRSets(rrs)...)
	return &syncv1.Zone{Apex: z.Apex, Rrsets: sets}, nil
}

func PutZone(z *syncv1.Zone) *syncv1.Op {
	return &syncv1.Op{Op: &syncv1.Op_PutZone{PutZone: z}}
}

func DeleteZone(apex string) *syncv1.Op {
	return &syncv1.Op{Op: &syncv1.Op_DeleteZone{DeleteZone: apex}}
}

func PutRRSet(apex string, set *syncv1.RRSet) *syncv1.Op {
	return &syncv1.Op{Op: &syncv1.Op_PutRrset{PutRrset: &syncv1.ZoneRRSet{Apex: apex, Rrset: set}}}
}

func DeleteRRSet(apex, owner string, typ uint16) *syncv1.Op {
	return &syncv1.Op{Op: &syncv1.Op_DeleteRrset{DeleteRrset: &syncv1.RRSetKey{Apex: apex, Owner: owner, Type: uint32(typ), RrClass: uint32(ClassIN)}}}
}

func RRSetOp(apex, owner string, typ uint16, members []RR) *syncv1.Op {
	if len(members) == 0 {
		return DeleteRRSet(apex, owner, typ)
	}
	return PutRRSet(apex, RRSets(members)[0])
}

func appendBytes(dst, b []byte) []byte {
	dst = binary.BigEndian.AppendUint32(dst, u32(len(b)))
	return append(dst, b...)
}

func Preimage(zones []*syncv1.Zone) []byte {
	zs := append([]*syncv1.Zone(nil), zones...)
	sort.Slice(zs, func(i, j int) bool { return zs[i].GetApex() < zs[j].GetApex() })
	out := binary.BigEndian.AppendUint32(nil, u32(len(zs)))
	for _, z := range zs {
		out = appendBytes(out, []byte(z.GetApex()))
		sets := append([]*syncv1.RRSet(nil), z.GetRrsets()...)
		sort.Slice(sets, func(i, j int) bool {
			a, b := sets[i], sets[j]
			if a.GetOwner() != b.GetOwner() {
				return a.GetOwner() < b.GetOwner()
			}
			if a.GetType() != b.GetType() {
				return a.GetType() < b.GetType()
			}
			return a.GetRrClass() < b.GetRrClass()
		})
		out = binary.BigEndian.AppendUint32(out, u32(len(sets)))
		for _, set := range sets {
			out = appendBytes(out, []byte(set.GetOwner()))
			out = binary.BigEndian.AppendUint32(out, set.GetType())
			out = binary.BigEndian.AppendUint32(out, set.GetRrClass())
			out = binary.BigEndian.AppendUint32(out, set.GetTtl())
			rdata := append([][]byte(nil), set.GetRdata()...)
			sort.Slice(rdata, func(i, j int) bool { return bytes.Compare(rdata[i], rdata[j]) < 0 })
			out = binary.BigEndian.AppendUint32(out, u32(len(rdata)))
			for _, rd := range rdata {
				out = appendBytes(out, rd)
			}
		}
	}
	return out
}

func Digest(zones []*syncv1.Zone) [sha256.Size]byte {
	return sha256.Sum256(Preimage(zones))
}

const RRFixedWireLen = 10

func NameWireLen(name string) int {
	if name == "." || name == "" {
		return 1
	}
	return len(strings.TrimSuffix(name, ".")) + 2
}

func RRWireSize(owner string, rdataLen int) int {
	return NameWireLen(owner) + RRFixedWireLen + rdataLen
}
