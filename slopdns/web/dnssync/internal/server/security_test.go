package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"slopdns/web/dnssync/internal/store"
	syncv1 "slopdns/web/gen/slopdns/sync/v1"
)

type failedChangeSource struct{ Source }

func (failedChangeSource) ChangesAfter(context.Context, uint64, string, int) ([]store.Change, error) {
	return nil, errors.New("database unavailable")
}

type quietNotifier struct{ ch chan struct{} }

func (n quietNotifier) Head() uint64             { return 1 }
func (n quietNotifier) Changed() <-chan struct{} { return n.ch }

func TestDatabaseFailureDoesNotRenewFreshnessWithHeartbeat(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{src: failedChangeSource{}, notify: quietNotifier{make(chan struct{})}, opts: Options{Heartbeat: time.Millisecond, DeltaBatch: 10}}
	ss := &session{srv: s, ctx: ctx, log: logger, out: make(chan *syncv1.ServerFrame, 1)}
	if err := ss.live(1, "anchor"); status.Code(err) != codes.Unavailable {
		t.Fatalf("got %v", err)
	}
	if len(ss.out) != 0 {
		t.Fatal("signed a heartbeat while authoritative state was unavailable")
	}
}
