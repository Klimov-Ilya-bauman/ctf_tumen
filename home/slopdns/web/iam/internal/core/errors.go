package core

import (
	"errors"
	"fmt"
	"time"
)

type Kind int

const (
	KindInternal Kind = iota
	KindInvalid
	KindUnauthenticated
	KindInvalidCredentials
	KindMFAInvalid
	KindForbidden
	KindNotFound
	KindConflict
	KindFailedPrecondition
	KindRateLimited
	KindUnavailable
)

type Error struct {
	Kind       Kind
	Field      string
	Message    string
	RetryAfter time.Duration
	cause      error
}

func (e *Error) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s (field %s)", e.Message, e.Field)
	}
	return e.Message
}

func (e *Error) Unwrap() error {
	return e.cause
}

func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return KindInternal
}

func invalid(field, msg string) *Error {
	return &Error{Kind: KindInvalid, Field: field, Message: msg}
}

func notFound(msg string) *Error {
	return &Error{Kind: KindNotFound, Message: msg}
}

func forbidden(msg string) *Error {
	return &Error{Kind: KindForbidden, Message: msg}
}

func conflict(msg string) *Error {
	return &Error{Kind: KindConflict, Message: msg}
}

func precondition(msg string) *Error {
	return &Error{Kind: KindFailedPrecondition, Message: msg}
}

func mfaInvalid() *Error {
	return &Error{Kind: KindMFAInvalid, Message: "invalid or expired second factor"}
}

func invalidCredentials() *Error {
	return &Error{Kind: KindInvalidCredentials, Message: "invalid username or password"}
}

func busy() *Error {
	return &Error{Kind: KindRateLimited, Message: "server is busy, retry later", RetryAfter: time.Second}
}

func unavailable(msg string, cause error) *Error {
	return &Error{Kind: KindUnavailable, Message: msg, cause: cause}
}

func internal(cause error) *Error {
	return &Error{Kind: KindInternal, Message: "internal error", cause: cause}
}
