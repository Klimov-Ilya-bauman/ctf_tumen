package rrdata

import (
	"encoding/hex"
	"errors"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/miekg/dns"

	"slopdns/web/backend/internal/conv"
	"slopdns/web/backend/internal/dnsname"
)

const MaxCharString = 255

var errWrongRR = errors.New("unexpected RR type")

func required[T any](p *T, field string) (T, *FieldError) {
	if p == nil {
		var zero T
		return zero, fieldErr(field, "is required")
	}
	return *p, nil
}

func uintField(p *int64, field string, maxValue int64) (int64, *FieldError) {
	v, ferr := required(p, field)
	if ferr != nil {
		return 0, ferr
	}
	if v < 0 || v > maxValue {
		return 0, fieldErr(field, "must be between 0 and %d", maxValue)
	}
	return v, nil
}

func enumField(p *int64, field string, allowed ...int64) (int64, *FieldError) {
	v, ferr := required(p, field)
	if ferr != nil {
		return 0, ferr
	}
	for _, a := range allowed {
		if v == a {
			return v, nil
		}
	}
	return 0, fieldErr(field, "value %d is not allowed", v)
}

func hostField(p *string, field string, allowRoot bool) (string, *FieldError) {
	v, ferr := required(p, field)
	if ferr != nil {
		return "", ferr
	}
	if len(v) > 254 {
		return "", fieldErr(field, "is longer than 254 characters")
	}
	name, err := dnsname.ParseHost(v, allowRoot)
	if err != nil {
		return "", fieldErr(field, "%s", err.Error())
	}
	return name, nil
}

func charStringField(p *string, field string) (string, *FieldError) {
	v, ferr := required(p, field)
	if ferr != nil {
		return "", ferr
	}
	if len(v) > MaxCharString {
		return "", fieldErr(field, "is longer than 255 octets")
	}
	return v, nil
}

func ptr[T any](v T) *T {
	return &v
}

type AData struct {
	Address *string `json:"address"`
}

func (d *AData) build() (any, dns.RR, *FieldError) {
	v, ferr := required(d.Address, "address")
	if ferr != nil {
		return nil, nil, ferr
	}
	addr, err := netip.ParseAddr(v)
	if err != nil || !addr.Is4() || addr.String() != v {
		return nil, nil, fieldErr("address", "must be a dotted-quad IPv4 address")
	}
	b := addr.As4()
	return &AData{Address: ptr(addr.String())}, &dns.A{A: b[:]}, nil
}

func (d *AData) fromRR(rr dns.RR) error {
	a, ok := rr.(*dns.A)
	if !ok {
		return errWrongRR
	}
	addr, ok := netip.AddrFromSlice(a.A)
	if !ok {
		return errors.New("bad IPv4 address")
	}
	d.Address = ptr(addr.Unmap().String())
	return nil
}

type AAAAData struct {
	Address *string `json:"address"`
}

func (d *AAAAData) build() (any, dns.RR, *FieldError) {
	v, ferr := required(d.Address, "address")
	if ferr != nil {
		return nil, nil, ferr
	}
	if len(v) < 2 || len(v) > 45 {
		return nil, nil, fieldErr("address", "must be an IPv6 address")
	}
	addr, err := netip.ParseAddr(v)
	if err != nil || !addr.Is6() || addr.Zone() != "" {
		return nil, nil, fieldErr("address", "must be an IPv6 address")
	}
	b := addr.As16()
	return &AAAAData{Address: ptr(addr.String())}, &dns.AAAA{AAAA: b[:]}, nil
}

func (d *AAAAData) fromRR(rr dns.RR) error {
	a, ok := rr.(*dns.AAAA)
	if !ok {
		return errWrongRR
	}
	addr, ok := netip.AddrFromSlice(a.AAAA)
	if !ok || len(a.AAAA) != 16 {
		return errors.New("bad IPv6 address")
	}
	d.Address = ptr(addr.String())
	return nil
}

type NSData struct {
	Nsdname *string `json:"nsdname"`
}

func (d *NSData) build() (any, dns.RR, *FieldError) {
	name, ferr := hostField(d.Nsdname, "nsdname", false)
	if ferr != nil {
		return nil, nil, ferr
	}
	return &NSData{Nsdname: &name}, &dns.NS{Ns: name}, nil
}

func (d *NSData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.NS)
	if !ok {
		return errWrongRR
	}
	d.Nsdname = ptr(v.Ns)
	return nil
}

type CNAMEData struct {
	Target *string `json:"target"`
}

func (d *CNAMEData) build() (any, dns.RR, *FieldError) {
	name, ferr := hostField(d.Target, "target", false)
	if ferr != nil {
		return nil, nil, ferr
	}
	return &CNAMEData{Target: &name}, &dns.CNAME{Target: name}, nil
}

func (d *CNAMEData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.CNAME)
	if !ok {
		return errWrongRR
	}
	d.Target = ptr(v.Target)
	return nil
}

type DNAMEData struct {
	Target *string `json:"target"`
}

func (d *DNAMEData) build() (any, dns.RR, *FieldError) {
	name, ferr := hostField(d.Target, "target", false)
	if ferr != nil {
		return nil, nil, ferr
	}
	return &DNAMEData{Target: &name}, &dns.DNAME{Target: name}, nil
}

func (d *DNAMEData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.DNAME)
	if !ok {
		return errWrongRR
	}
	d.Target = ptr(v.Target)
	return nil
}

type PTRData struct {
	Ptrdname *string `json:"ptrdname"`
}

func (d *PTRData) build() (any, dns.RR, *FieldError) {
	name, ferr := hostField(d.Ptrdname, "ptrdname", false)
	if ferr != nil {
		return nil, nil, ferr
	}
	return &PTRData{Ptrdname: &name}, &dns.PTR{Ptr: name}, nil
}

func (d *PTRData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.PTR)
	if !ok {
		return errWrongRR
	}
	d.Ptrdname = ptr(v.Ptr)
	return nil
}

type MXData struct {
	Preference *int64  `json:"preference"`
	Exchange   *string `json:"exchange"`
}

func (d *MXData) build() (any, dns.RR, *FieldError) {
	pref, ferr := uintField(d.Preference, "preference", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	name, ferr := hostField(d.Exchange, "exchange", true)
	if ferr != nil {
		return nil, nil, ferr
	}
	return &MXData{Preference: &pref, Exchange: &name}, &dns.MX{Preference: conv.U16(pref), Mx: name}, nil
}

func (d *MXData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.MX)
	if !ok {
		return errWrongRR
	}
	d.Preference = ptr(int64(v.Preference))
	d.Exchange = ptr(v.Mx)
	return nil
}

type TXTData struct {
	Strings *[]string `json:"strings"`
}

func (d *TXTData) build() (any, dns.RR, *FieldError) {
	list, ferr := required(d.Strings, "strings")
	if ferr != nil {
		return nil, nil, ferr
	}
	if len(list) < 1 || len(list) > 255 {
		return nil, nil, fieldErr("strings", "must contain 1..255 character-strings")
	}
	out := make([]string, len(list))
	escaped := make([]string, len(list))
	total := 0
	for i, s := range list {
		if len(s) > MaxCharString {
			return nil, nil, fieldErr("strings["+strconv.Itoa(i)+"]", "is longer than 255 octets")
		}
		total += 1 + len(s)
		out[i] = s
		escaped[i] = escapeForPack(s)
	}
	if total > MaxRdataLen {
		return nil, nil, fieldErr("strings", "total RDATA is longer than 65535 octets")
	}
	return &TXTData{Strings: &out}, &dns.TXT{Txt: escaped}, nil
}

func (d *TXTData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.TXT)
	if !ok {
		return errWrongRR
	}
	out := make([]string, len(v.Txt))
	for i, s := range v.Txt {
		out[i] = unescape(s)
	}
	d.Strings = &out
	return nil
}

type SRVData struct {
	Priority *int64  `json:"priority"`
	Weight   *int64  `json:"weight"`
	Port     *int64  `json:"port"`
	Target   *string `json:"target"`
}

func (d *SRVData) build() (any, dns.RR, *FieldError) {
	prio, ferr := uintField(d.Priority, "priority", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	weight, ferr := uintField(d.Weight, "weight", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	port, ferr := uintField(d.Port, "port", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	target, ferr := hostField(d.Target, "target", true)
	if ferr != nil {
		return nil, nil, ferr
	}
	canon := &SRVData{Priority: &prio, Weight: &weight, Port: &port, Target: &target}
	return canon, &dns.SRV{Priority: conv.U16(prio), Weight: conv.U16(weight), Port: conv.U16(port), Target: target}, nil
}

func (d *SRVData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.SRV)
	if !ok {
		return errWrongRR
	}
	d.Priority = ptr(int64(v.Priority))
	d.Weight = ptr(int64(v.Weight))
	d.Port = ptr(int64(v.Port))
	d.Target = ptr(v.Target)
	return nil
}

type CAAData struct {
	Flags *int64  `json:"flags"`
	Tag   *string `json:"tag"`
	Value *string `json:"value"`
}

var (
	caaTagRe      = regexp.MustCompile(`^[A-Za-z0-9]{1,15}$`)
	caaParamTagRe = regexp.MustCompile(`^[A-Za-z0-9]+$`)
)

func (d *CAAData) build() (any, dns.RR, *FieldError) {
	flags, ferr := enumField(d.Flags, "flags", 0, 128)
	if ferr != nil {
		return nil, nil, ferr
	}
	tag, ferr := required(d.Tag, "tag")
	if ferr != nil {
		return nil, nil, ferr
	}
	if !caaTagRe.MatchString(tag) {
		return nil, nil, fieldErr("tag", "must be 1..15 ASCII letters and digits")
	}
	value, ferr := required(d.Value, "value")
	if ferr != nil {
		return nil, nil, ferr
	}
	if len(value) > 2048 {
		return nil, nil, fieldErr("value", "is longer than 2048 characters")
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] > 0x7e {
			return nil, nil, fieldErr("value", "must contain only printable ASCII characters")
		}
	}
	if msg := validateCAAValue(strings.ToLower(tag), value); msg != "" {
		return nil, nil, fieldErr("value", "%s", msg)
	}
	canon := &CAAData{Flags: &flags, Tag: &tag, Value: &value}
	wire := make([]byte, 0, 2+len(tag)+len(value))
	wire = append(wire, conv.U8(flags), conv.U8(int64(len(tag))))
	wire = append(wire, tag...)
	wire = append(wire, value...)
	return canon, &dns.PrivateRR{Hdr: dns.RR_Header{Rrtype: TypeCAA}, Data: &rawRdata{data: wire}}, nil
}

func validateCAAValue(tag, value string) string {
	switch tag {
	case "issue", "issuewild":
		parts := strings.Split(value, ";")
		issuer := strings.Trim(parts[0], " \t")
		if issuer != "" {
			if _, err := dnsname.Parse(issuer, dnsname.ZonePolicy); err != nil || strings.HasSuffix(issuer, ".") {
				return "issuer must be a domain name (RFC 8659 section 4.2)"
			}
		}
		for _, p := range parts[1:] {
			p = strings.Trim(p, " \t")
			if p == "" {
				continue
			}
			k, v, ok := strings.Cut(p, "=")
			if !ok || !caaParamTagRe.MatchString(k) || strings.ContainsAny(v, " \t") {
				return "parameters must be tag=value pairs (RFC 8659 section 4.2)"
			}
		}
	case "iodef":
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "mailto" && u.Scheme != "http" && u.Scheme != "https") || (u.Scheme != "mailto" && u.Host == "") || (u.Scheme == "mailto" && u.Opaque == "") {
			return "iodef must be a mailto:, http: or https: URL (RFC 8659 section 4.4)"
		}
	}
	return ""
}

func (d *CAAData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.CAA)
	if !ok {
		return errWrongRR
	}
	d.Flags = ptr(int64(v.Flag))
	d.Tag = ptr(unescape(v.Tag))
	d.Value = ptr(v.Value)
	return nil
}

type HINFOData struct {
	CPU *string `json:"cpu"`
	OS  *string `json:"os"`
}

func (d *HINFOData) build() (any, dns.RR, *FieldError) {
	cpu, ferr := charStringField(d.CPU, "cpu")
	if ferr != nil {
		return nil, nil, ferr
	}
	os, ferr := charStringField(d.OS, "os")
	if ferr != nil {
		return nil, nil, ferr
	}
	return &HINFOData{CPU: &cpu, OS: &os}, &dns.HINFO{Cpu: escapeForPack(cpu), Os: escapeForPack(os)}, nil
}

func (d *HINFOData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.HINFO)
	if !ok {
		return errWrongRR
	}
	d.CPU = ptr(unescape(v.Cpu))
	d.OS = ptr(unescape(v.Os))
	return nil
}

type SSHFPData struct {
	Algorithm       *int64  `json:"algorithm"`
	FingerprintType *int64  `json:"fingerprint_type"`
	Fingerprint     *string `json:"fingerprint"`
}

func hexField(p *string, field string, minLen, maxLen int) (string, *FieldError) {
	v, ferr := required(p, field)
	if ferr != nil {
		return "", ferr
	}
	if len(v) < minLen || len(v) > maxLen || len(v)%2 != 0 {
		return "", fieldErr(field, "must be an even number of hex digits (%d..%d)", minLen, maxLen)
	}
	if _, err := hex.DecodeString(v); err != nil {
		return "", fieldErr(field, "must contain only hex digits")
	}
	return strings.ToLower(v), nil
}

func (d *SSHFPData) build() (any, dns.RR, *FieldError) {
	alg, ferr := enumField(d.Algorithm, "algorithm", 1, 2, 3, 4, 6)
	if ferr != nil {
		return nil, nil, ferr
	}
	ft, ferr := enumField(d.FingerprintType, "fingerprint_type", 1, 2)
	if ferr != nil {
		return nil, nil, ferr
	}
	fp, ferr := hexField(d.Fingerprint, "fingerprint", 40, 64)
	if ferr != nil {
		return nil, nil, ferr
	}
	if (ft == 1 && len(fp) != 40) || (ft == 2 && len(fp) != 64) {
		return nil, nil, fieldErr("fingerprint", "length does not match fingerprint_type (SHA-1: 40, SHA-256: 64 hex digits)")
	}
	canon := &SSHFPData{Algorithm: &alg, FingerprintType: &ft, Fingerprint: &fp}
	return canon, &dns.SSHFP{Algorithm: conv.U8(alg), Type: conv.U8(ft), FingerPrint: fp}, nil
}

func (d *SSHFPData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.SSHFP)
	if !ok {
		return errWrongRR
	}
	d.Algorithm = ptr(int64(v.Algorithm))
	d.FingerprintType = ptr(int64(v.Type))
	d.Fingerprint = ptr(v.FingerPrint)
	return nil
}

type TLSAData struct {
	Usage                      *int64  `json:"usage"`
	Selector                   *int64  `json:"selector"`
	MatchingType               *int64  `json:"matching_type"`
	CertificateAssociationData *string `json:"certificate_association_data"`
}

func (d *TLSAData) build() (any, dns.RR, *FieldError) {
	usage, ferr := enumField(d.Usage, "usage", 0, 1, 2, 3, 255)
	if ferr != nil {
		return nil, nil, ferr
	}
	sel, ferr := enumField(d.Selector, "selector", 0, 1, 255)
	if ferr != nil {
		return nil, nil, ferr
	}
	mt, ferr := enumField(d.MatchingType, "matching_type", 0, 1, 2, 255)
	if ferr != nil {
		return nil, nil, ferr
	}
	data, ferr := hexField(d.CertificateAssociationData, "certificate_association_data", 2, 16384)
	if ferr != nil {
		return nil, nil, ferr
	}
	if (mt == 1 && len(data) != 64) || (mt == 2 && len(data) != 128) {
		return nil, nil, fieldErr("certificate_association_data", "length does not match matching_type (SHA-256: 64, SHA-512: 128 hex digits)")
	}
	canon := &TLSAData{Usage: &usage, Selector: &sel, MatchingType: &mt, CertificateAssociationData: &data}
	return canon, &dns.TLSA{Usage: conv.U8(usage), Selector: conv.U8(sel), MatchingType: conv.U8(mt), Certificate: data}, nil
}

func (d *TLSAData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.TLSA)
	if !ok {
		return errWrongRR
	}
	d.Usage = ptr(int64(v.Usage))
	d.Selector = ptr(int64(v.Selector))
	d.MatchingType = ptr(int64(v.MatchingType))
	d.CertificateAssociationData = ptr(v.Certificate)
	return nil
}

type NAPTRData struct {
	Order       *int64  `json:"order"`
	Preference  *int64  `json:"preference"`
	Flags       *string `json:"flags"`
	Services    *string `json:"services"`
	Regexp      *string `json:"regexp"`
	Replacement *string `json:"replacement"`
}

var (
	naptrFlagsRe    = regexp.MustCompile(`^[A-Za-z0-9]*$`)
	naptrServicesRe = regexp.MustCompile(`^[A-Za-z0-9+:._-]*$`)
)

func (d *NAPTRData) build() (any, dns.RR, *FieldError) {
	order, ferr := uintField(d.Order, "order", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	pref, ferr := uintField(d.Preference, "preference", 65535)
	if ferr != nil {
		return nil, nil, ferr
	}
	flags, ferr := charStringField(d.Flags, "flags")
	if ferr != nil {
		return nil, nil, ferr
	}
	if !naptrFlagsRe.MatchString(flags) {
		return nil, nil, fieldErr("flags", "must contain only ASCII letters and digits")
	}
	services, ferr := charStringField(d.Services, "services")
	if ferr != nil {
		return nil, nil, ferr
	}
	if !naptrServicesRe.MatchString(services) {
		return nil, nil, fieldErr("services", "contains characters that are not allowed")
	}
	re, ferr := charStringField(d.Regexp, "regexp")
	if ferr != nil {
		return nil, nil, ferr
	}
	repl, ferr := hostField(d.Replacement, "replacement", true)
	if ferr != nil {
		return nil, nil, ferr
	}
	if (re == "") == (repl == dnsname.Root) {
		return nil, nil, fieldErr("regexp", "exactly one of regexp (non-empty) and replacement (not '.') must be set")
	}
	if re != "" {
		if msg := validateNAPTRRegexp(re); msg != "" {
			return nil, nil, fieldErr("regexp", "%s", msg)
		}
	}
	canon := &NAPTRData{Order: &order, Preference: &pref, Flags: &flags, Services: &services, Regexp: &re, Replacement: &repl}
	rr := &dns.NAPTR{Order: conv.U16(order), Preference: conv.U16(pref), Flags: flags, Service: services, Regexp: escapeForPack(re), Replacement: repl}
	return canon, rr, nil
}

func validateNAPTRRegexp(re string) string {
	if !utf8.ValidString(re) {
		return "must be valid UTF-8"
	}
	delim, size := utf8.DecodeRuneInString(re)
	if delim == '\\' || delim == 'i' || (delim >= '0' && delim <= '9') || delim == 0 {
		return "delimiter must not be a digit, backslash or 'i' (RFC 3403 section 3.2)"
	}
	var parts []string
	var cur strings.Builder
	rest := re[size:]
	for i := 0; i < len(rest); {
		r, n := utf8.DecodeRuneInString(rest[i:])
		if r == '\\' && i+n < len(rest) {
			r2, n2 := utf8.DecodeRuneInString(rest[i+n:])
			if r2 == delim {
				cur.WriteRune(r2)
			} else {
				cur.WriteRune(r)
				cur.WriteRune(r2)
			}
			i += n + n2
			continue
		}
		if r == delim {
			parts = append(parts, cur.String())
			cur.Reset()
			i += n
			continue
		}
		cur.WriteRune(r)
		i += n
	}
	parts = append(parts, cur.String())
	if len(parts) != 3 {
		return "must have the form <delim>ere<delim>replacement<delim>flags (RFC 3403 section 3.2)"
	}
	if parts[0] == "" {
		return "the regular expression must not be empty"
	}
	if parts[2] != "" && parts[2] != "i" {
		return "the only allowed flag is 'i'"
	}
	if _, err := regexp.CompilePOSIX(parts[0]); err != nil {
		return "the regular expression is not a valid POSIX ERE"
	}
	return ""
}

func (d *NAPTRData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.NAPTR)
	if !ok {
		return errWrongRR
	}
	d.Order = ptr(int64(v.Order))
	d.Preference = ptr(int64(v.Preference))
	d.Flags = ptr(unescape(v.Flags))
	d.Services = ptr(unescape(v.Service))
	d.Regexp = ptr(unescape(v.Regexp))
	d.Replacement = ptr(v.Replacement)
	return nil
}

type GPTData struct {
	Text *string `json:"text"`
}

func (d *GPTData) build() (any, dns.RR, *FieldError) {
	text, ferr := required(d.Text, "text")
	if ferr != nil {
		return nil, nil, ferr
	}
	if len(text) > GPTMaxTextLen {
		return nil, nil, fieldErr("text", "is longer than 40 octets after UTF-8 encoding")
	}
	if !utf8.ValidString(text) {
		return nil, nil, fieldErr("text", "must be valid UTF-8")
	}
	rr, ok := dns.TypeToRR[TypeGPT]().(*dns.PrivateRR)
	if !ok {
		return nil, nil, fieldErr("text", "GPT type is not registered")
	}
	rr.Data = &GPT{Text: text}
	return &GPTData{Text: &text}, rr, nil
}

func (d *GPTData) fromRR(rr dns.RR) error {
	v, ok := rr.(*dns.PrivateRR)
	if !ok {
		return errWrongRR
	}
	g, ok := v.Data.(*GPT)
	if !ok {
		return errWrongRR
	}
	d.Text = ptr(g.Text)
	return nil
}
