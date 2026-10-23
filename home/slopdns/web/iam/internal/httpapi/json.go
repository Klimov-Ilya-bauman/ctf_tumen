package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
)

type opt[T any] struct {
	Set   bool
	Value T
}

var errNull = errors.New("null is not allowed")

func (o *opt[T]) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errNull
	}
	if err := json.Unmarshal(data, &o.Value); err != nil {
		return err
	}
	o.Set = true
	return nil
}

func (o opt[T]) ptr() *T {
	if !o.Set {
		return nil
	}
	v := o.Value
	return &v
}
