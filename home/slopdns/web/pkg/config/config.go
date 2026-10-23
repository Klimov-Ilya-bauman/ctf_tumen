package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

type Problem struct {
	Var     string
	Message string
}

type Error struct {
	Problems []Problem
}

func (e *Error) Error() string {
	parts := make([]string, 0, len(e.Problems))
	for _, p := range e.Problems {
		parts = append(parts, p.Var+": "+p.Message)
	}
	return "invalid configuration: " + strings.Join(parts, "; ")
}

type LookupFunc func(string) (string, bool)

type ReadFileFunc func(string) ([]byte, error)

type Env struct {
	lookup   LookupFunc
	readFile ReadFileFunc
	problems []Problem
}

func New(lookup LookupFunc) *Env {
	return &Env{lookup: lookup, readFile: os.ReadFile}
}

func FromOS() *Env {
	return New(os.LookupEnv)
}

func FromMap(m map[string]string) *Env {
	return New(func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	})
}

func (e *Env) WithReadFile(f ReadFileFunc) *Env {
	e.readFile = f
	return e
}

func (e *Env) Fail(name, format string, args ...any) {
	e.problems = append(e.problems, Problem{Var: name, Message: fmt.Sprintf(format, args...)})
}

func (e *Env) Err() error {
	if len(e.problems) == 0 {
		return nil
	}
	return &Error{Problems: slices.Clone(e.problems)}
}

func (e *Env) raw(name string) (string, bool) {
	v, ok := e.lookup(name)
	if !ok {
		return "", false
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return "", false
	}
	return v, true
}

func (e *Env) String(name, def string) string {
	if v, ok := e.raw(name); ok {
		return v
	}
	return def
}

func (e *Env) Required(name string) string {
	v, ok := e.raw(name)
	if !ok {
		e.Fail(name, "is required")
		return ""
	}
	return v
}

func (e *Env) Secret(name string, required bool) string {
	v, okValue := e.raw(name)
	path, okFile := e.raw(name + "_FILE")
	switch {
	case okValue && okFile:
		e.Fail(name, "set either %s or %s_FILE, not both", name, name)
		return ""
	case okValue:
		return v
	case okFile:
		data, err := e.readFile(path)
		if err != nil {
			e.Fail(name+"_FILE", "cannot read file %q: %v", path, unwrapPathError(err))
			return ""
		}
		s := strings.TrimRight(string(data), "\r\n")
		if s == "" {
			e.Fail(name+"_FILE", "file %q is empty", path)
		}
		return s
	default:
		if required {
			e.Fail(name, "is required (set %s or %s_FILE)", name, name)
		}
		return ""
	}
}

func (e *Env) Int(name string, def, minValue, maxValue int) int {
	v, ok := e.raw(name)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		e.Fail(name, "must be an integer")
		return def
	}
	if n < minValue || n > maxValue {
		e.Fail(name, "must be between %d and %d", minValue, maxValue)
		return def
	}
	return n
}

func (e *Env) Float(name string, def, minValue, maxValue float64) float64 {
	v, ok := e.raw(name)
	if !ok {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		e.Fail(name, "must be a number")
		return def
	}
	if f < minValue || f > maxValue {
		e.Fail(name, "must be between %g and %g", minValue, maxValue)
		return def
	}
	return f
}

func (e *Env) Duration(name string, def, minValue, maxValue time.Duration) time.Duration {
	v, ok := e.raw(name)
	if !ok {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		e.Fail(name, "must be a duration such as 300ms, 5s or 1h")
		return def
	}
	if d < minValue || d > maxValue {
		e.Fail(name, "must be between %s and %s", minValue, maxValue)
		return def
	}
	return d
}

func (e *Env) Bool(name string, def bool) bool {
	v, ok := e.raw(name)
	if !ok {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	e.Fail(name, "must be true or false")
	return def
}

func (e *Env) OneOf(name, def string, allowed ...string) string {
	v, ok := e.raw(name)
	if !ok {
		return def
	}
	if !slices.Contains(allowed, v) {
		e.Fail(name, "must be one of %s", strings.Join(allowed, ", "))
		return def
	}
	return v
}

func (e *Env) Addr(name, def string) string {
	v := e.String(name, def)
	if v == "" {
		e.Fail(name, "is required")
		return ""
	}
	if err := ValidateAddr(v); err != nil {
		e.Fail(name, "%v", err)
		return def
	}
	return v
}

func (e *Env) URL(name, def string, required bool, schemes ...string) string {
	v := e.String(name, def)
	if v == "" {
		if required {
			e.Fail(name, "is required")
		}
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || u.Scheme == "" {
		e.Fail(name, "must be an absolute URL")
		return def
	}
	if len(schemes) > 0 && !slices.Contains(schemes, u.Scheme) {
		e.Fail(name, "URL scheme must be one of %s", strings.Join(schemes, ", "))
		return def
	}
	return v
}

func (e *Env) File(name, def string, required bool) string {
	v := e.String(name, def)
	if v == "" {
		if required {
			e.Fail(name, "is required")
		}
		return ""
	}
	if _, err := e.readFile(v); err != nil {
		e.Fail(name, "cannot read file %q: %v", v, unwrapPathError(err))
	}
	return v
}

func (e *Env) List(name string, def []string) []string {
	v, ok := e.raw(name)
	if !ok {
		return slices.Clone(def)
	}
	var out []string
	for _, item := range strings.Split(v, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	if len(out) == 0 {
		e.Fail(name, "must contain at least one comma-separated item")
		return slices.Clone(def)
	}
	return out
}

func ValidateAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return errors.New("must be host:port or :port")
	}
	if host != "" && strings.ContainsAny(host, " /") {
		return errors.New("host contains invalid characters")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	return nil
}

func unwrapPathError(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
