package rrdata

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/miekg/dns"

	"slopdns/web/backend/internal/conv"
)

const (
	TypeGPT       uint16 = 65280
	GPTMnemonic          = "GPT"
	GPTMaxTextLen        = 40
)

var (
	errGPTTooLong   = errors.New("GPT text is longer than 40 octets")
	errGPTTruncated = errors.New("GPT RDATA is truncated")
	errGPTUTF8      = errors.New("GPT text is not valid UTF-8")
	errGPTTokens    = errors.New("GPT RDATA must be a single character-string")
)

type GPT struct {
	Text string
}

func init() {
	dns.PrivateHandle(GPTMnemonic, TypeGPT, func() dns.PrivateRdata { return new(GPT) })
}

func (g *GPT) Len() int {
	return 1 + len(g.Text)
}

func (g *GPT) String() string {
	return quoteCharString(g.Text)
}

func (g *GPT) Parse(tokens []string) error {
	if len(tokens) > 1 {
		return errGPTTokens
	}
	text := ""
	if len(tokens) == 1 {
		text = unescape(tokens[0])
	}
	if len(text) > GPTMaxTextLen {
		return errGPTTooLong
	}
	if !utf8.ValidString(text) {
		return errGPTUTF8
	}
	g.Text = text
	return nil
}

func (g *GPT) Pack(buf []byte) (int, error) {
	if len(g.Text) > GPTMaxTextLen {
		return 0, errGPTTooLong
	}
	if len(buf) < 1+len(g.Text) {
		return 0, dns.ErrBuf
	}
	buf[0] = conv.U8(int64(len(g.Text)))
	copy(buf[1:], g.Text)
	return 1 + len(g.Text), nil
}

func (g *GPT) Unpack(buf []byte) (int, error) {
	if len(buf) < 1 {
		return 0, errGPTTruncated
	}
	n := int(buf[0])
	if n > GPTMaxTextLen {
		return 0, errGPTTooLong
	}
	if len(buf) < 1+n {
		return 0, errGPTTruncated
	}
	g.Text = string(buf[1 : 1+n])
	return 1 + n, nil
}

func (g *GPT) Copy(dst dns.PrivateRdata) error {
	d, ok := dst.(*GPT)
	if !ok {
		return dns.ErrRdata
	}
	d.Text = g.Text
	return nil
}

func quoteCharString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c < 0x20 || c == 0x7f:
			b.WriteByte('\\')
			d := strconv.Itoa(int(c))
			b.WriteString(strings.Repeat("0", 3-len(d)))
			b.WriteString(d)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func unescape(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 >= len(s) {
			out = append(out, c)
			continue
		}
		if i+3 < len(s) && isDigit(s[i+1]) && isDigit(s[i+2]) && isDigit(s[i+3]) {
			v := int(s[i+1]-'0')*100 + int(s[i+2]-'0')*10 + int(s[i+3]-'0')
			if v <= 255 {
				out = append(out, conv.U8(int64(v)))
				i += 3
				continue
			}
		}
		out = append(out, s[i+1])
		i++
	}
	return string(out)
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func escapeForPack(s string) string {
	return strings.ReplaceAll(s, "\\", "\\\\")
}

type rawRdata struct {
	data []byte
}

func (r *rawRdata) String() string {
	return FormatGeneric(r.data)
}

func (r *rawRdata) Parse([]string) error {
	return dns.ErrRdata
}

func (r *rawRdata) Pack(buf []byte) (int, error) {
	if len(buf) < len(r.data) {
		return 0, dns.ErrBuf
	}
	return copy(buf, r.data), nil
}

func (r *rawRdata) Unpack(buf []byte) (int, error) {
	r.data = append([]byte(nil), buf...)
	return len(buf), nil
}

func (r *rawRdata) Copy(dst dns.PrivateRdata) error {
	d, ok := dst.(*rawRdata)
	if !ok {
		return dns.ErrRdata
	}
	d.data = append([]byte(nil), r.data...)
	return nil
}

func (r *rawRdata) Len() int {
	return len(r.data)
}

func quoteOctets(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		if s[i] == '"' || s[i] == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(s[i])
	}
	b.WriteByte('"')
	return b.String()
}
