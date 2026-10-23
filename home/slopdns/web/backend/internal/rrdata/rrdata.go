package rrdata

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/miekg/dns"

	"slopdns/web/backend/internal/conv"
)

const (
	ClassIN      uint16 = 1
	MaxRdataLen         = 65535
	TypeA        uint16 = 1
	TypeNS       uint16 = 2
	TypeCNAME    uint16 = 5
	TypeSOA      uint16 = 6
	TypePTR      uint16 = 12
	TypeHINFO    uint16 = 13
	TypeMX       uint16 = 15
	TypeTXT      uint16 = 16
	TypeAAAA     uint16 = 28
	TypeSRV      uint16 = 33
	TypeNAPTR    uint16 = 35
	TypeDNAME    uint16 = 39
	TypeOPT      uint16 = 41
	TypeDS       uint16 = 43
	TypeSSHFP    uint16 = 44
	TypeRRSIG    uint16 = 46
	TypeNSEC     uint16 = 47
	TypeDNSKEY   uint16 = 48
	TypeNSEC3    uint16 = 50
	TypeNSEC3PAR uint16 = 51
	TypeTLSA     uint16 = 52
	TypeCAA      uint16 = 257
)

type FieldError struct {
	Field   string
	Message string
}

func (e *FieldError) Error() string {
	return e.Field + ": " + e.Message
}

type SyntaxError struct {
	Message string
}

func (e *SyntaxError) Error() string {
	return e.Message
}

func fieldErr(field, format string, args ...any) *FieldError {
	return &FieldError{Field: field, Message: fmt.Sprintf(format, args...)}
}

type Record struct {
	Type uint16
	Data any
	Wire []byte
}

func (r *Record) Mnemonic() string {
	return Mnemonic(r.Type)
}

func (r *Record) DataJSON() ([]byte, error) {
	return json.Marshal(r.Data)
}

type input interface {
	build() (any, dns.RR, *FieldError)
	fromRR(rr dns.RR) error
}

type handler struct {
	name     string
	newInput func() input
}

var handlers = map[uint16]handler{
	TypeA:     {"A", func() input { return new(AData) }},
	TypeNS:    {"NS", func() input { return new(NSData) }},
	TypeCNAME: {"CNAME", func() input { return new(CNAMEData) }},
	TypePTR:   {"PTR", func() input { return new(PTRData) }},
	TypeHINFO: {"HINFO", func() input { return new(HINFOData) }},
	TypeMX:    {"MX", func() input { return new(MXData) }},
	TypeTXT:   {"TXT", func() input { return new(TXTData) }},
	TypeAAAA:  {"AAAA", func() input { return new(AAAAData) }},
	TypeSRV:   {"SRV", func() input { return new(SRVData) }},
	TypeNAPTR: {"NAPTR", func() input { return new(NAPTRData) }},
	TypeDNAME: {"DNAME", func() input { return new(DNAMEData) }},
	TypeSSHFP: {"SSHFP", func() input { return new(SSHFPData) }},
	TypeTLSA:  {"TLSA", func() input { return new(TLSAData) }},
	TypeCAA:   {"CAA", func() input { return new(CAAData) }},
	TypeGPT:   {GPTMnemonic, func() input { return new(GPTData) }},
}

var byName = func() map[string]uint16 {
	m := make(map[string]uint16, len(handlers))
	for code, h := range handlers {
		m[h.name] = code
	}
	return m
}()

func StructuredTypes() []string {
	out := make([]string, 0, len(byName))
	for name := range byName {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func IsStructured(code uint16) bool {
	_, ok := handlers[code]
	return ok
}

func Mnemonic(code uint16) string {
	if h, ok := handlers[code]; ok {
		return h.name
	}
	return "TYPE" + strconv.Itoa(int(code))
}

func ForbiddenGeneric(code uint32) bool {
	switch {
	case code == 0, code > 65535:
		return true
	case code >= 128 && code <= 255:
		return true
	}
	switch uint16(code) {
	case TypeSOA, TypeOPT, TypeRRSIG, TypeNSEC, TypeNSEC3, TypeNSEC3PAR:
		return true
	}
	return false
}

func parseTypeNumber(s string) (uint32, bool) {
	if !strings.HasPrefix(s, "TYPE") {
		return 0, false
	}
	digits := s[4:]
	if digits == "" || len(digits) > 5 || digits[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(digits); i++ {
		if !isDigit(digits[i]) {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(digits, 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(n), true
}

const GenericNotAccepted = "the generic RFC 3597 form (TYPEnnn with \\# hex RDATA) is not accepted; use a named record type"

func ParseType(s string) (uint16, error) {
	if c, ok := byName[s]; ok {
		return c, nil
	}
	if s == "SOA" {
		return 0, fieldErr("type", "SOA is managed through the zone soa settings")
	}
	if _, ok := parseTypeNumber(s); ok {
		return 0, fieldErr("type", "%s", GenericNotAccepted)
	}
	return 0, fieldErr("type", "unsupported record type %q", s)
}

func ParseFilterType(s string) (uint16, error) {
	if c, ok := byName[s]; ok {
		return c, nil
	}
	n, ok := parseTypeNumber(s)
	if !ok || n > 65535 {
		return 0, fieldErr("type", "unknown record type %q", s)
	}
	return conv.U16(int64(n)), nil
}

func jsonFields(dst any) map[string]bool {
	t := reflect.TypeOf(dst)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	out := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out[name] = true
		}
	}
	return out
}

func checkKeys(data json.RawMessage, dst any) error {
	allowed := jsonFields(dst)
	dec := json.NewDecoder(bytes.NewReader(data))
	if _, err := dec.Token(); err != nil {
		return &SyntaxError{Message: "field data is malformed"}
	}
	seen := map[string]bool{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return &SyntaxError{Message: "field data is malformed"}
		}
		key, ok := tok.(string)
		if !ok {
			return &SyntaxError{Message: "field data is malformed"}
		}
		if !allowed[key] {
			return &SyntaxError{Message: "unknown field data." + key}
		}
		if seen[key] {
			return &SyntaxError{Message: "duplicate field data." + key}
		}
		seen[key] = true
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return &SyntaxError{Message: "field data is malformed"}
		}
	}
	return nil
}

func decodeStrict(data json.RawMessage, dst any) error {
	if err := checkKeys(data, dst); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &typeErr) && typeErr.Field != "":
			return &SyntaxError{Message: "field data." + typeErr.Field + " has wrong type"}
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			name := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), "\"")
			return &SyntaxError{Message: "unknown field data." + name}
		}
		return &SyntaxError{Message: "field data is malformed"}
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &SyntaxError{Message: "field data is malformed"}
	}
	return nil
}

func isNullOrMissing(data json.RawMessage) bool {
	t := bytes.TrimSpace(data)
	return len(t) == 0 || bytes.Equal(t, []byte("null"))
}

func Parse(typ string, data json.RawMessage) (*Record, error) {
	code, err := ParseType(typ)
	if err != nil {
		return nil, err
	}
	if isNullOrMissing(data) {
		return nil, fieldErr("data", "is required")
	}
	if t := bytes.TrimSpace(data); t[0] != '{' {
		return nil, &SyntaxError{Message: "field data must be an object"}
	}
	in := handlers[code].newInput()
	if err := decodeStrict(data, in); err != nil {
		return nil, err
	}
	return buildRecord(code, in, "data.")
}

func buildRecord(code uint16, in input, prefix string) (*Record, error) {
	canon, rr, ferr := in.build()
	if ferr != nil {
		return nil, &FieldError{Field: prefix + ferr.Field, Message: ferr.Message}
	}
	wire, err := Pack(code, rr)
	if err != nil {
		return nil, fieldErr(strings.TrimSuffix(prefix, "."), "cannot encode RDATA: %v", err)
	}
	return &Record{Type: code, Data: canon, Wire: wire}, nil
}

func genericRecord(code uint16, wire []byte) *Record {
	text := FormatGeneric(wire)
	return &Record{Type: code, Data: &GenericData{Rdata: &text}, Wire: wire}
}

func FromWire(code uint16, wire []byte) (*Record, error) {
	if len(wire) > MaxRdataLen {
		return nil, fieldErr("rdata", "RDATA is longer than 65535 octets")
	}
	h, ok := handlers[code]
	if !ok {
		if ForbiddenGeneric(uint32(code)) {
			return nil, fieldErr("type", "record type %s is not allowed", Mnemonic(code))
		}
		return genericRecord(code, append([]byte(nil), wire...)), nil
	}
	rr, err := Unpack(code, wire)
	if err != nil {
		return nil, fieldErr("rdata", "malformed RDATA: %v", err)
	}
	in := h.newInput()
	if err := in.fromRR(rr); err != nil {
		return nil, fieldErr("rdata", "malformed RDATA: %v", err)
	}
	rec, err := buildRecord(code, in, "")
	if err != nil {
		return nil, err
	}
	if !wireMatches(wire, rec.Wire) {
		return nil, fieldErr("rdata", "RDATA is not in canonical uncompressed form")
	}
	return rec, nil
}

func wireMatches(in, canon []byte) bool {
	if len(in) != len(canon) {
		return false
	}
	for i := range in {
		a := in[i]
		if a >= 'A' && a <= 'Z' {
			a += 'a' - 'A'
		}
		if in[i] != canon[i] && a != canon[i] {
			return false
		}
	}
	return true
}

func Pack(code uint16, rr dns.RR) ([]byte, error) {
	hdr := rr.Header()
	hdr.Name = "."
	hdr.Rrtype = code
	hdr.Class = ClassIN
	buf := make([]byte, MaxRdataLen+64)
	off, err := dns.PackRR(rr, buf, 0, nil, false)
	if err != nil {
		return nil, err
	}
	const headerLen = 11
	out := make([]byte, off-headerLen)
	copy(out, buf[headerLen:off])
	return out, nil
}

func Unpack(code uint16, wire []byte) (dns.RR, error) {
	if len(wire) == 0 {
		return nil, errors.New("empty RDATA")
	}
	h := dns.RR_Header{Name: ".", Rrtype: code, Class: ClassIN, Rdlength: conv.U16(int64(len(wire)))}
	rr, _, err := dns.UnpackRRWithHeader(h, wire, 0)
	if err != nil {
		return nil, err
	}
	return rr, nil
}

func Presentation(owner string, ttl uint32, code uint16, wire []byte) (string, error) {
	if !IsStructured(code) {
		return fmt.Sprintf("%s\t%d\tIN\t%s\t%s", owner, ttl, Mnemonic(code), FormatGeneric(wire)), nil
	}
	rr, err := Unpack(code, wire)
	if err != nil {
		return "", err
	}
	if caa, ok := rr.(*dns.CAA); ok {
		return fmt.Sprintf("%s\t%d\tIN\tCAA\t%d %s %s", owner, ttl, caa.Flag, caa.Tag, quoteOctets(caa.Value)), nil
	}
	rr.Header().Name = owner
	rr.Header().Ttl = ttl
	return rr.String(), nil
}

func NormalizeData(code uint16, data []byte) []byte {
	var dst any = &GenericData{}
	if h, ok := handlers[code]; ok {
		dst = h.newInput()
	}
	if err := json.Unmarshal(data, dst); err == nil {
		if out, err := json.Marshal(dst); err == nil {
			return out
		}
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		return data
	}
	return buf.Bytes()
}
