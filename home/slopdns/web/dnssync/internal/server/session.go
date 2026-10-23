package server

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"math"
	"sync/atomic"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/dnssync/internal/store"
	"slopdns/web/pkg/dnsdata"
	"slopdns/web/pkg/syncproto"
)

const frameOverhead = 1024

func u32(v int64) uint32 {
	if v < 0 || v > math.MaxUint32 {
		return 0
	}
	return uint32(v)
}

type session struct {
	srv     *Server
	ctx     context.Context
	cancel  context.CancelCauseFunc
	node    string
	addr    string
	key     ed25519.PublicKey
	id      []byte
	out     chan *syncv1.ServerFrame
	started time.Time
	log     *slog.Logger
	sent    atomic.Uint64
	acked   atomic.Uint64
}

func (ss *session) attrs() []any {
	return []any{slog.Uint64("sent_revision", ss.sent.Load()), slog.Uint64("acked_revision", ss.acked.Load()), slog.Duration("duration", time.Since(ss.started))}
}

func (ss *session) sendLoop(stream syncv1.DnsSyncService_StreamServer) {
	for {
		select {
		case <-ss.ctx.Done():
			return
		case f := <-ss.out:
			if err := stream.Send(f); err != nil {
				ss.cancel(err)
				return
			}
		}
	}
}

func (ss *session) enqueue(kind syncv1.FrameKind, body proto.Message) error {
	f, err := syncproto.SignServer(ss.srv.opts.Signer, kind, ss.id, body)
	if err != nil {
		return status.Error(codes.Internal, "sign frame")
	}
	select {
	case ss.out <- f:
		return nil
	default:
	}
	t := time.NewTimer(ss.srv.opts.SendTimeout)
	defer t.Stop()
	select {
	case ss.out <- f:
		return nil
	case <-t.C:
		ss.log.WarnContext(ss.ctx, "dropping slow sync client", slog.Int("queued_frames", len(ss.out)), slog.Duration("send_timeout", ss.srv.opts.SendTimeout))
		return errSlowClient
	case <-ss.ctx.Done():
		return context.Cause(ss.ctx)
	}
}

func (ss *session) serve(hello *syncv1.Hello, in <-chan *syncv1.ClientFrame) error {
	last := hello.GetLastRevision()
	pos, err := ss.srv.src.Locate(ss.ctx, last)
	if err != nil {
		ss.log.WarnContext(ss.ctx, "change_log lookup failed", slog.Any("error", err))
		return status.Error(codes.Unavailable, "change_log is unavailable")
	}
	full, reason := resyncDecision(last, pos)
	if prevRev, prevFP := ss.srv.lastSent(ss.node); !full && last == prevRev && prevFP != "" && pos.Fingerprint != prevFP {
		full, reason = true, "change_log was reset: revision content differs from what this node received"
		ss.log.ErrorContext(ss.ctx, "change_log reset detected at handshake", slog.Uint64("last_revision", last))
	}
	if full {
		ss.srv.recordResync(ss.node, reason)
	}
	ss.log.InfoContext(ss.ctx, "sync session started",
		slog.Uint64("last_revision", last), slog.Uint64("head_revision", pos.Head), slog.Bool("full_resync", full), slog.String("reason", reason))
	welcome := &syncv1.Welcome{
		SessionId:           ss.id,
		ClientNonce:         hello.GetNonce(),
		CurrentRevision:     pos.Head,
		FullResync:          full,
		HeartbeatIntervalMs: u32(ss.srv.opts.Heartbeat.Milliseconds()),
		ProtoVersion:        syncproto.ProtoVersion,
	}
	if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_WELCOME, welcome); err != nil {
		return err
	}
	go ss.ackLoop(in)
	sent, anchor := last, pos.Fingerprint
	if full {
		if sent, anchor, err = ss.sendSnapshot(); err != nil {
			return err
		}
	}
	ss.sent.Store(sent)
	return ss.live(sent, anchor)
}

func resyncDecision(last uint64, pos store.Position) (bool, string) {
	switch {
	case last == 0:
		return true, "client has no data"
	case last > pos.Head:
		return true, "client revision is ahead of change_log"
	case !pos.Exists:
		return true, "client revision is not in change_log"
	}
	return false, "catch up from change_log"
}

func (ss *session) ackLoop(in <-chan *syncv1.ClientFrame) {
	for {
		var f *syncv1.ClientFrame
		select {
		case <-ss.ctx.Done():
			return
		case f = <-in:
		}
		if err := ss.handleClientFrame(f); err != nil {
			ss.log.WarnContext(ss.ctx, "rejected client frame", slog.Any("error", err))
			ss.cancel(err)
			return
		}
	}
}

func (ss *session) handleClientFrame(f *syncv1.ClientFrame) error {
	kind, signed, err := syncproto.UnwrapClient(f)
	if err != nil {
		return status.Error(codes.InvalidArgument, "unknown client frame")
	}
	if kind != syncv1.FrameKind_FRAME_KIND_ACK {
		return status.Errorf(codes.InvalidArgument, "unexpected %s after hello", kind)
	}
	ack := &syncv1.Ack{}
	if err := syncproto.Open(ss.key, kind, ss.id, signed, ack); err != nil {
		if errors.Is(err, syncproto.ErrBadSignature) {
			return status.Error(codes.Unauthenticated, "ack signature is invalid")
		}
		return status.Error(codes.InvalidArgument, "ack payload is malformed")
	}
	rev := ack.GetRevision()
	if rev > ss.sent.Load() {
		return status.Errorf(codes.InvalidArgument, "ack revision %d was never sent", rev)
	}
	for {
		cur := ss.acked.Load()
		if rev <= cur || ss.acked.CompareAndSwap(cur, rev) {
			break
		}
	}
	ss.srv.recordAck(ss.node, rev)
	head := ss.srv.notify.Head()
	lag := uint64(0)
	if head > rev {
		lag = head - rev
	}
	ss.log.DebugContext(ss.ctx, "sync ack", slog.Uint64("acked_revision", rev), slog.Uint64("head_revision", head), slog.Uint64("lag", lag))
	return nil
}

func zoneFieldSize(z *syncv1.Zone) int {
	n := proto.Size(z)
	return protowire.SizeTag(2) + protowire.SizeBytes(n)
}

func Chunk(zones []*syncv1.Zone, target int) ([][]*syncv1.Zone, error) {
	var out [][]*syncv1.Zone
	var cur []*syncv1.Zone
	size := 0
	for _, z := range zones {
		n := zoneFieldSize(z)
		if n > syncproto.MaxMessageSize-frameOverhead {
			return nil, status.Errorf(codes.Internal, "zone %s does not fit into one sync message (%d bytes)", z.GetApex(), n)
		}
		if len(cur) > 0 && size+n > target {
			out = append(out, cur)
			cur, size = nil, 0
		}
		cur = append(cur, z)
		size += n
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out, nil
}

func (ss *session) sendSnapshot() (uint64, string, error) {
	start := time.Now()
	snap, err := ss.srv.src.Snapshot(ss.ctx)
	if err != nil {
		if ss.ctx.Err() != nil {
			return 0, "", context.Cause(ss.ctx)
		}
		ss.log.WarnContext(ss.ctx, "snapshot read failed", slog.Any("error", err))
		return 0, "", status.Error(codes.Unavailable, "snapshot is unavailable")
	}
	for _, p := range snap.Problems {
		ss.log.ErrorContext(ss.ctx, "invalid data left out of the snapshot", slog.Uint64("revision", snap.Revision), slog.Any("error", p))
	}
	chunks, err := Chunk(snap.Zones, ss.srv.opts.ChunkBytes)
	if err != nil {
		ss.log.ErrorContext(ss.ctx, "snapshot cannot be chunked", slog.Any("error", err))
		return 0, "", err
	}
	count := u32(int64(len(snap.Zones)))
	if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_SNAPSHOT_BEGIN, &syncv1.SnapshotBegin{Revision: snap.Revision, ZoneCount: count}); err != nil {
		return 0, "", err
	}
	for _, c := range chunks {
		if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_SNAPSHOT_CHUNK, &syncv1.SnapshotChunk{Revision: snap.Revision, Zones: c}); err != nil {
			return 0, "", err
		}
	}
	digest := dnsdata.Digest(snap.Zones)
	ss.sent.Store(snap.Revision)
	if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_SNAPSHOT_END, &syncv1.SnapshotEnd{Revision: snap.Revision, Digest: digest[:]}); err != nil {
		return 0, "", err
	}
	ss.srv.recordSnapshot(ss.node)
	ss.srv.recordSent(ss.node, snap.Revision, snap.Fingerprint)
	ss.log.InfoContext(ss.ctx, "snapshot queued", slog.Uint64("revision", snap.Revision), slog.Int("zones", len(snap.Zones)), slog.Int("chunks", len(chunks)), slog.Duration("duration", time.Since(start)))
	return snap.Revision, snap.Fingerprint, nil
}

func (ss *session) live(sent uint64, anchor string) error {
	hb := time.NewTicker(ss.srv.opts.Heartbeat)
	defer hb.Stop()
	for {
		wake := ss.srv.notify.Changed()
		changes, err := ss.srv.src.ChangesAfter(ss.ctx, sent, anchor, ss.srv.opts.DeltaBatch)
		var retry <-chan time.Time
		switch {
		case errors.Is(err, store.ErrReset):
			ss.log.ErrorContext(ss.ctx, "change_log reset detected, closing the stream for a full resync", slog.Uint64("sent_revision", sent), slog.Uint64("head_revision", ss.srv.notify.Head()), slog.Any("error", err))
			ss.srv.recordResync(ss.node, "change_log reset detected: "+err.Error())
			return errReset
		case errors.Is(err, store.ErrPruned):
			ss.log.WarnContext(ss.ctx, "session revision was pruned from change_log", slog.Uint64("sent_revision", sent))
			return errPruned
		case err != nil:
			if ss.ctx.Err() != nil {
				return context.Cause(ss.ctx)
			}
			ss.log.WarnContext(ss.ctx, "change_log read failed, keeping the stream with heartbeats", slog.Any("error", err))
			retry = time.After(ss.srv.opts.RetryInterval)
		}
		for _, c := range changes {
			if c.Revision <= sent {
				continue
			}
			for _, p := range c.Problems {
				ss.log.ErrorContext(ss.ctx, "invalid data left out of a delta", slog.Uint64("revision", c.Revision), slog.Any("error", p))
			}
			prev := sent
			ss.sent.Store(c.Revision)
			if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_DELTA, &syncv1.Delta{PrevRevision: prev, Revision: c.Revision, Ops: c.Ops}); err != nil {
				return err
			}
			sent, anchor = c.Revision, c.Fingerprint
			ss.srv.recordSent(ss.node, sent, anchor)
		}
		if err == nil && len(changes) >= ss.srv.opts.DeltaBatch {
			continue
		}
		select {
		case <-ss.ctx.Done():
			return context.Cause(ss.ctx)
		case <-wake:
		case <-retry:
		case <-hb.C:
			if err := ss.enqueue(syncv1.FrameKind_FRAME_KIND_HEARTBEAT, &syncv1.Heartbeat{CurrentRevision: sent, UnixMs: time.Now().UnixMilli()}); err != nil {
				return err
			}
		}
	}
}
