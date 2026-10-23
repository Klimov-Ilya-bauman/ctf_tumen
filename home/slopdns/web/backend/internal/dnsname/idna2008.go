package dnsname

import (
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

var (
	pvalidExceptions     = map[rune]bool{0x00DF: true, 0x03C2: true, 0x06FD: true, 0x06FE: true, 0x0F0B: true, 0x3007: true}
	disallowedExceptions = map[rune]bool{0x0640: true, 0x07FA: true, 0x302E: true, 0x302F: true, 0x3031: true, 0x3032: true, 0x3033: true, 0x3034: true, 0x3035: true, 0x303B: true}
	letterDigits         = []*unicode.RangeTable{unicode.Ll, unicode.Lo, unicode.Lm, unicode.Mn, unicode.Mc, unicode.Nd}
	ignorable            = []*unicode.RangeTable{unicode.Other_Default_Ignorable_Code_Point, unicode.Variation_Selector, unicode.Noncharacter_Code_Point, unicode.White_Space}
	ignorableBlocks      = [][2]rune{{0x20D0, 0x20FF}, {0x1D100, 0x1D1FF}, {0x1D200, 0x1D24F}}
	oldHangulJamo        = [][2]rune{{0x1100, 0x11FF}, {0xA960, 0xA97F}, {0xD7B0, 0xD7FF}}
	folder               = cases.Fold()
)

func inRanges(r rune, ranges [][2]rune) bool {
	for _, rg := range ranges {
		if r >= rg[0] && r <= rg[1] {
			return true
		}
	}
	return false
}

func PValid(r rune) bool {
	if pvalidExceptions[r] {
		return true
	}
	if disallowedExceptions[r] {
		return false
	}
	if r == '-' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
		return true
	}
	if r < utf8.RuneSelf {
		return false
	}
	if !unicode.In(r, letterDigits...) || unicode.In(r, ignorable...) || inRanges(r, ignorableBlocks) || inRanges(r, oldHangulJamo) {
		return false
	}
	s := string(r)
	return norm.NFKC.String(folder.String(norm.NFKC.String(s))) == s
}

func checkULabel(alabel string) error {
	u, err := lookup.ToUnicode(alabel)
	if err != nil {
		return fail(ReasonInvalidPunycode, "label is not valid punycode")
	}
	back, err := lookup.ToASCII(u)
	if err != nil || back != alabel {
		return fail(ReasonInvalidPunycode, "label is not a canonical IDNA A-label")
	}
	if runes := []rune(u); len(runes) >= 4 && runes[2] == '-' && runes[3] == '-' {
		return fail(ReasonInvalidLabel, "label must not have hyphens in the third and fourth positions (RFC 5891 section 4.2.3.1)")
	}
	if !norm.NFC.IsNormalString(u) {
		return fail(ReasonInvalidLabel, "label is not in Unicode NFC form")
	}
	for i, r := range u {
		if !PValid(r) {
			return fail(ReasonInvalidLabel, "label contains a code point that IDNA2008 (RFC 5892) does not allow")
		}
		if i == 0 && unicode.In(r, unicode.Mn, unicode.Mc) {
			return fail(ReasonInvalidLabel, "label must not start with a combining mark (RFC 5891 section 4.2.3.2)")
		}
	}
	return nil
}
