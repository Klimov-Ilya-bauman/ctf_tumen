package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
)

type Code string

const (
	CodeBadRequest         Code = "bad_request"
	CodeUnauthenticated    Code = "unauthenticated"
	CodeInvalidCredentials Code = "invalid_credentials"
	CodeMFAInvalid         Code = "mfa_invalid"
	CodeCSRFRequired       Code = "csrf_required"
	CodeForbidden          Code = "forbidden"
	CodeNotFound           Code = "not_found"
	CodeConflict           Code = "conflict"
	CodeValidationFailed   Code = "validation_failed"
	CodeQuotaExceeded      Code = "quota_exceeded"
	CodeRateLimited        Code = "rate_limited"
	CodeInternal           Code = "internal_error"
	CodeUnavailable        Code = "service_unavailable"
)

const DefaultMaxBodyBytes int64 = 1 << 20

const (
	maxMessageLength = 1024
	maxFieldLength   = 256
)

type Error struct {
	Status  int
	Code    Code
	Message string
	Field   string
	Headers http.Header
	cause   error
}

func (e *Error) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s: %s (field %s)", e.Code, e.Message, e.Field)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	return e.cause
}

func (e *Error) WithCause(err error) *Error {
	c := *e
	c.cause = err
	return &c
}

func NewError(status int, code Code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func BadRequest(message string) *Error {
	return NewError(http.StatusBadRequest, CodeBadRequest, message)
}

func Unauthenticated(message string) *Error {
	return NewError(http.StatusUnauthorized, CodeUnauthenticated, message)
}

func Forbidden(message string) *Error {
	return NewError(http.StatusForbidden, CodeForbidden, message)
}

func NotFound(message string) *Error {
	return NewError(http.StatusNotFound, CodeNotFound, message)
}

func Conflict(message string) *Error {
	return NewError(http.StatusConflict, CodeConflict, message)
}

func Validation(field, message string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: CodeValidationFailed, Message: message, Field: field}
}

func QuotaExceeded(field, message string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: CodeQuotaExceeded, Message: message, Field: field}
}

func RateLimited(retryAfterSeconds int) *Error {
	if retryAfterSeconds < 1 {
		retryAfterSeconds = 1
	}
	e := NewError(http.StatusTooManyRequests, CodeRateLimited, "too many requests")
	e.Headers = http.Header{"Retry-After": []string{strconv.Itoa(retryAfterSeconds)}}
	return e
}

func Internal() *Error {
	return NewError(http.StatusInternalServerError, CodeInternal, "internal error")
}

func Unavailable(message string) *Error {
	return NewError(http.StatusServiceUnavailable, CodeUnavailable, message)
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, err error) {
	var he *Error
	if !errors.As(err, &he) {
		he = Internal()
	}
	for k, vs := range he.Headers {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, he.Status, errorBody{Error: errorDetail{
		Code:    he.Code,
		Message: truncate(nonEmpty(he.Message, string(he.Code)), maxMessageLength),
		Field:   truncate(he.Field, maxFieldLength),
	}})
}

func ReportError(logger *slog.Logger, w http.ResponseWriter, r *http.Request, err error) {
	var he *Error
	if !errors.As(err, &he) || he.Status >= 500 {
		logger.ErrorContext(r.Context(), "request failed", slog.String("method", r.Method), slog.String("path", r.URL.Path), slog.Any("error", err))
	}
	WriteError(w, err)
}

func nonEmpty(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}

func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) error {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	if r.Body == nil || r.Body == http.NoBody {
		return BadRequest("request body is required")
	}
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return BadRequest("Content-Type must be application/json")
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil || mt != "application/json" {
		return BadRequest("Content-Type must be application/json")
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return BadRequest("request body is too large").WithCause(err)
		}
		return BadRequest("cannot read request body").WithCause(err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return decodeError(err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return BadRequest("request body must contain a single JSON value")
	}
	if err := checkKeys(data, reflect.TypeOf(dst)); err != nil {
		return err
	}
	return nil
}

func decodeError(err error) *Error {
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	var mbe *http.MaxBytesError
	switch {
	case errors.As(err, &mbe):
		return BadRequest("request body is too large").WithCause(err)
	case errors.As(err, &syntaxErr):
		return BadRequest(fmt.Sprintf("malformed JSON at offset %d", syntaxErr.Offset)).WithCause(err)
	case errors.Is(err, io.EOF):
		return BadRequest("request body is required").WithCause(err)
	case errors.Is(err, io.ErrUnexpectedEOF):
		return BadRequest("malformed JSON").WithCause(err)
	case errors.As(err, &typeErr):
		if typeErr.Field != "" {
			return BadRequest(fmt.Sprintf("field %s has wrong type", typeErr.Field)).WithCause(err)
		}
		return BadRequest("request body has wrong type").WithCause(err)
	case strings.HasPrefix(err.Error(), "json: unknown field "):
		name := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), "\"")
		return BadRequest(fmt.Sprintf("unknown field %s", name)).WithCause(err)
	}
	return BadRequest("malformed JSON").WithCause(err)
}

func BodyLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > maxBytes {
				WriteError(w, BadRequest("request body is too large"))
				return
			}
			if r.Body != nil && r.Body != http.NoBody {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}

func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tw := &trackingWriter{ResponseWriter: w}
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				logger.ErrorContext(r.Context(), "panic in handler", slog.Any("panic", rec), slog.String("path", r.URL.Path), slog.Bool("response_started", tw.started))
				if tw.started {
					panic(http.ErrAbortHandler)
				}
				WriteError(w, Internal())
			}()
			next.ServeHTTP(tw, r)
		})
	}
}

func NotFoundHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, NotFound("not found"))
	})
}

func MethodNotAllowed(allowed ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(allowed) > 0 {
			w.Header().Set("Allow", strings.Join(allowed, ", "))
		}
		WriteError(w, NewError(http.StatusMethodNotAllowed, CodeBadRequest, "method not allowed"))
	})
}

func Chain(h http.Handler, middlewares ...func(http.Handler) http.Handler) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}

type trackingWriter struct {
	http.ResponseWriter
	started bool
}

func (t *trackingWriter) WriteHeader(code int) {
	if code >= 200 {
		t.started = true
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *trackingWriter) Write(b []byte) (int, error) {
	t.started = true
	return t.ResponseWriter.Write(b)
}

func (t *trackingWriter) Flush() {
	t.started = true
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (t *trackingWriter) Unwrap() http.ResponseWriter {
	return t.ResponseWriter
}
