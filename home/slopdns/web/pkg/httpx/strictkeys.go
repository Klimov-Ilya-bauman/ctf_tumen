package httpx

import (
	"bytes"
	"encoding"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"unicode"
)

const maxKeyInMessage = 64

var (
	jsonUnmarshalerType = reflect.TypeFor[json.Unmarshaler]()
	textUnmarshalerType = reflect.TypeFor[encoding.TextUnmarshaler]()
	fieldCache          sync.Map
)

func checkKeys(data []byte, t reflect.Type) *Error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return walkValue(dec, t)
}

func shortKey(k string) string {
	if len(k) > maxKeyInMessage {
		return truncate(k, maxKeyInMessage)
	}
	return k
}

func walkValue(dec *json.Decoder, t reflect.Type) *Error {
	tok, err := dec.Token()
	if err != nil {
		return BadRequest("malformed JSON").WithCause(err)
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	t = schemaType(t)
	switch delim {
	case '{':
		return walkObject(dec, t)
	case '[':
		var elem reflect.Type
		if t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
			elem = t.Elem()
		}
		for dec.More() {
			if e := walkValue(dec, elem); e != nil {
				return e
			}
		}
		if _, err := dec.Token(); err != nil {
			return BadRequest("malformed JSON").WithCause(err)
		}
	}
	return nil
}

func walkObject(dec *json.Decoder, t reflect.Type) *Error {
	var fields map[string]reflect.Type
	var elem reflect.Type
	if t != nil {
		switch t.Kind() {
		case reflect.Struct:
			fields = structFields(t)
		case reflect.Map:
			elem = t.Elem()
		}
	}
	seen := map[string]bool{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return BadRequest("malformed JSON").WithCause(err)
		}
		key, _ := tok.(string)
		if seen[key] {
			return BadRequest(fmt.Sprintf("duplicate field %s", shortKey(key)))
		}
		seen[key] = true
		child := elem
		if fields != nil {
			ft, exact := fields[key]
			if !exact {
				return BadRequest(fmt.Sprintf("unknown field %s", shortKey(key)))
			}
			child = ft
		}
		if e := walkValue(dec, child); e != nil {
			return e
		}
	}
	if _, err := dec.Token(); err != nil {
		return BadRequest("malformed JSON").WithCause(err)
	}
	return nil
}

func schemaType(t reflect.Type) reflect.Type {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == nil || t.Kind() == reflect.Interface {
		return nil
	}
	if t.Implements(jsonUnmarshalerType) || reflect.PointerTo(t).Implements(jsonUnmarshalerType) ||
		t.Implements(textUnmarshalerType) || reflect.PointerTo(t).Implements(textUnmarshalerType) {
		return nil
	}
	return t
}

func structFields(t reflect.Type) map[string]reflect.Type {
	if v, ok := fieldCache.Load(t); ok {
		return v.(map[string]reflect.Type)
	}
	out := map[string]reflect.Type{}
	for _, f := range typeFields(t) {
		out[f.name] = f.typ
	}
	fieldCache.Store(t, out)
	return out
}

type fieldInfo struct {
	name   string
	tagged bool
	index  []int
	typ    reflect.Type
}

type pendingStruct struct {
	typ   reflect.Type
	index []int
}

func typeFields(t reflect.Type) []fieldInfo {
	var current []pendingStruct
	next := []pendingStruct{{typ: t}}
	var count, nextCount map[reflect.Type]int
	visited := map[reflect.Type]bool{}
	var fields []fieldInfo
	for len(next) > 0 {
		current, next = next, nil
		count, nextCount = nextCount, map[reflect.Type]int{}
		for _, p := range current {
			if visited[p.typ] {
				continue
			}
			visited[p.typ] = true
			for i := 0; i < p.typ.NumField(); i++ {
				sf := p.typ.Field(i)
				if sf.Anonymous {
					et := sf.Type
					if et.Kind() == reflect.Pointer {
						et = et.Elem()
					}
					if !sf.IsExported() && et.Kind() != reflect.Struct {
						continue
					}
				} else if !sf.IsExported() {
					continue
				}
				tag := sf.Tag.Get("json")
				if tag == "-" {
					continue
				}
				name, _, _ := strings.Cut(tag, ",")
				if !validTagName(name) {
					name = ""
				}
				index := append(append([]int(nil), p.index...), i)
				ft := sf.Type
				if ft.Name() == "" && ft.Kind() == reflect.Pointer {
					ft = ft.Elem()
				}
				if name != "" || !sf.Anonymous || ft.Kind() != reflect.Struct {
					f := fieldInfo{name: name, tagged: name != "", index: index, typ: sf.Type}
					if f.name == "" {
						f.name = sf.Name
					}
					fields = append(fields, f)
					if count[p.typ] > 1 {
						fields = append(fields, f)
					}
					continue
				}
				nextCount[ft]++
				if nextCount[ft] == 1 {
					next = append(next, pendingStruct{typ: ft, index: index})
				}
			}
		}
	}
	sort.SliceStable(fields, func(i, j int) bool {
		a, b := fields[i], fields[j]
		if a.name != b.name {
			return a.name < b.name
		}
		if len(a.index) != len(b.index) {
			return len(a.index) < len(b.index)
		}
		if a.tagged != b.tagged {
			return a.tagged
		}
		return slices.Compare(a.index, b.index) < 0
	})
	var out []fieldInfo
	for advance, i := 0, 0; i < len(fields); i += advance {
		name := fields[i].name
		for advance = 1; i+advance < len(fields); advance++ {
			if fields[i+advance].name != name {
				break
			}
		}
		group := fields[i : i+advance]
		if len(group) > 1 && len(group[0].index) == len(group[1].index) && group[0].tagged == group[1].tagged {
			continue
		}
		out = append(out, group[0])
	}
	return out
}

func validTagName(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		switch {
		case strings.ContainsRune("!#$%&()*+-./:;<=>?@[]^_{|}~ ", c):
		case unicode.IsLetter(c), unicode.IsDigit(c):
		default:
			return false
		}
	}
	return true
}
