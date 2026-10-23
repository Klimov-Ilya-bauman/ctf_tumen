package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/dnssync/internal/store"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/syncproto"
)

const (
	DefaultHeartbeat      = 5 * time.Second
	DefaultHelloTimeout   = 10 * time.Second
	DefaultSendTimeout    = 30 * time.Second
	DefaultQueueSize      = 64
	DefaultDeltaBatch     = 256
	DefaultRetryInterval  = 2 * time.Second
	DefaultLagLogInterval = time.Minute
)

type Source interface {
	Locate(ctx context.Context, revision uint64) (store.Position, error)
	Snapshot(ctx context.Context) (*store.Snapshot, error)
	ChangesAfter(ctx context.Context, after uint64, anchor string, limit int) ([]store.Change, error)
}

type Notifier interface {
	Head() uint64
	Changed() <-chan struct{}
}

type Options struct {
	Signer         ed25519.PrivateKey
	NodeKeys       map[string]ed25519.PublicKey
	Heartbeat      time.Duration
	HelloTimeout   time.Duration
	SendTimeout    time.Duration
	QueueSize      int
	ChunkBytes     int
	DeltaBatch     int
	RetryInterval  time.Duration
	LagLogInterval time.Duration
	Logger         *slog.Logger
}

type NodeStatus struct {
	Node          string     `json:"node"`
	Connected     bool       `json:"connected"`
	Session       string     `json:"session,omitempty"`
	Peer          string     `json:"peer,omitempty"`
	SentRevision  uint64     `json:"sent_revision"`
	AckedRevision uint64     `json:"acked_revision"`
	Lag           uint64     `json:"lag"`
	Sessions      uint64     `json:"sessions_total"`
	Snapshots     uint64     `json:"snapshots_total"`
	ConnectedAt   *time.Time `json:"connected_at,omitempty"`
	LastAckAt     *time.Time `json:"last_ack_at,omitempty"`
	ResyncReason  string     `json:"resync_reason,omitempty"`
	ResyncAt      *time.Time `json:"resync_at,omitempty"`
}

type nodeState struct {
	acked        uint64
	lastAck      time.Time
	sessions     uint64
	snapshots    uint64
	sentRev      uint64
	sentFP       string
	resyncReason string
	resyncAt     time.Time
}

type Server struct {
	syncv1.UnimplementedDnsSyncServiceServer
	src      Source
	notify   Notifier
	opts     Options
	log      *slog.Logger
	mu       sync.Mutex
	closed   bool
	sessions map[*session]struct{}
	nodes    map[string]*nodeState
}

var (
	errSlowClient = status.Error(codes.ResourceExhausted, "client is not reading frames fast enough, reconnect")
	errShutdown   = status.Error(codes.Unavailable, "dns-sync is shutting down")
	errSuperseded = status.Error(codes.Aborted, "superseded by a newer session of the same node")
	errPruned     = status.Error(codes.Aborted, "revision is no longer in change_log, reconnect for a full resync")
	errReset      = status.Error(codes.Aborted, "change_log was reset, reconnect for a full resync")
	errClosedSend = errors.New("client closed the stream")
)

func New(src Source, notify Notifier, opts Options) (*Server, error) {
	if len(opts.Signer) != ed25519.PrivateKeySize {
		return nil, errors.New("server: signing key is required")
	}
	if len(opts.NodeKeys) == 0 {
		return nil, errors.New("server: at least one node key is required")
	}
	for node, key := range opts.NodeKeys {
		if !mtls.ValidNodeID(node) || len(key) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("server: invalid node %q or key", node)
		}
	}
	if opts.Heartbeat <= 0 {
		opts.Heartbeat = DefaultHeartbeat
	}
	if opts.HelloTimeout <= 0 {
		opts.HelloTimeout = DefaultHelloTimeout
	}
	if opts.SendTimeout <= 0 {
		opts.SendTimeout = DefaultSendTimeout
	}
	if opts.QueueSize <= 0 {
		opts.QueueSize = DefaultQueueSize
	}
	if opts.ChunkBytes <= 0 {
		opts.ChunkBytes = syncproto.ChunkTarget
	}
	if opts.DeltaBatch <= 0 {
		opts.DeltaBatch = DefaultDeltaBatch
	}
	if opts.RetryInterval <= 0 {
		opts.RetryInterval = DefaultRetryInterval
	}
	if opts.LagLogInterval <= 0 {
		opts.LagLogInterval = DefaultLagLogInterval
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	nodes := make(map[string]*nodeState, len(opts.NodeKeys))
	for node := range opts.NodeKeys {
		nodes[node] = &nodeState{}
	}
	return &Server{src: src, notify: notify, opts: opts, log: opts.Logger, sessions: map[*session]struct{}{}, nodes: nodes}, nil
}

func (s *Server) VerifyPeer(leaf *x509.Certificate) error {
	node, err := mtls.DNSNodeID(leaf)
	if err != nil {
		return err
	}
	if _, ok := s.opts.NodeKeys[node]; !ok {
		return fmt.Errorf("%w: node %q is not in DNS_NODE_IDS", mtls.ErrPeerIdentity, node)
	}
	return nil
}

func peerIdentity(ctx context.Context) (string, string, error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return "", "", errors.New("no peer information")
	}
	info, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return "", "", errors.New("connection is not mTLS")
	}
	leaf, err := mtls.PeerLeaf(&info.State)
	if err != nil {
		return "", "", err
	}
	node, err := mtls.DNSNodeID(leaf)
	if err != nil {
		return "", "", err
	}
	addr := ""
	if p.Addr != nil {
		addr = p.Addr.String()
	}
	return node, addr, nil
}

func (s *Server) Stream(stream syncv1.DnsSyncService_StreamServer) error {
	ctx, cancel := context.WithCancelCause(stream.Context())
	defer cancel(nil)
	node, addr, err := peerIdentity(ctx)
	if err != nil {
		s.log.WarnContext(ctx, "sync stream rejected", slog.String("reason", "peer identity"), slog.Any("error", err))
		return status.Error(codes.PermissionDenied, "client certificate identity is not allowed")
	}
	key, ok := s.opts.NodeKeys[node]
	if !ok {
		s.log.WarnContext(ctx, "sync stream rejected", slog.String("node", node), slog.String("reason", "node not in DNS_NODE_IDS"))
		return status.Error(codes.PermissionDenied, "node is not allowed")
	}
	logger := s.log.With(slog.String("node", node), slog.String("peer", addr))
	in := make(chan *syncv1.ClientFrame, 1)
	go func() {
		for {
			f, err := stream.Recv()
			if err != nil {
				if errors.Is(err, io.EOF) {
					cancel(errClosedSend)
				} else {
					cancel(err)
				}
				return
			}
			select {
			case in <- f:
			case <-ctx.Done():
				return
			}
		}
	}()
	hello, err := s.awaitHello(ctx, in, node, key)
	if err != nil {
		logger.WarnContext(ctx, "sync handshake failed", slog.Any("error", err))
		return finalStatus(err)
	}
	sess, err := s.open(ctx, cancel, node, addr, key, logger)
	if err != nil {
		return finalStatus(err)
	}
	defer s.closeSession(sess)
	go sess.sendLoop(stream)
	err = sess.serve(hello, in)
	if errors.Is(err, errClosedSend) {
		sess.log.InfoContext(ctx, "sync session closed by client", sess.attrs()...)
		return nil
	}
	sess.log.InfoContext(ctx, "sync session ended", append(sess.attrs(), slog.Any("reason", err))...)
	return finalStatus(err)
}

func finalStatus(err error) error {
	if err == nil || errors.Is(err, errClosedSend) {
		return nil
	}
	if _, ok := status.FromError(err); ok {
		return err
	}
	if errors.Is(err, context.Canceled) {
		return status.Error(codes.Canceled, "stream canceled")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return status.Error(codes.DeadlineExceeded, "deadline exceeded")
	}
	return status.Error(codes.Unavailable, "sync data temporarily unavailable")
}

func (s *Server) awaitHello(ctx context.Context, in <-chan *syncv1.ClientFrame, node string, key ed25519.PublicKey) (*syncv1.Hello, error) {
	timer := time.NewTimer(s.opts.HelloTimeout)
	defer timer.Stop()
	var f *syncv1.ClientFrame
	select {
	case f = <-in:
	case <-timer.C:
		return nil, status.Error(codes.DeadlineExceeded, "no hello received")
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	}
	kind, signed, err := syncproto.UnwrapClient(f)
	if err != nil || kind != syncv1.FrameKind_FRAME_KIND_HELLO {
		return nil, status.Error(codes.InvalidArgument, "first frame must be hello")
	}
	hello := &syncv1.Hello{}
	if err := syncproto.Open(key, kind, syncproto.ZeroSession(), signed, hello); err != nil {
		if errors.Is(err, syncproto.ErrBadSignature) {
			return nil, status.Error(codes.Unauthenticated, "hello signature is invalid")
		}
		return nil, status.Error(codes.InvalidArgument, "hello payload is malformed")
	}
	if hello.GetNodeId() != node {
		return nil, status.Errorf(codes.PermissionDenied, "hello node_id %q does not match the certificate", hello.GetNodeId())
	}
	if len(hello.GetNonce()) != syncproto.NonceSize {
		return nil, status.Error(codes.InvalidArgument, "hello nonce must be 16 bytes")
	}
	if hello.GetProtoVersion() != syncproto.ProtoVersion {
		return nil, status.Errorf(codes.FailedPrecondition, "unsupported proto_version %d, want %d", hello.GetProtoVersion(), syncproto.ProtoVersion)
	}
	return hello, nil
}

func (s *Server) open(ctx context.Context, cancel context.CancelCauseFunc, node, addr string, key ed25519.PublicKey, logger *slog.Logger) (*session, error) {
	id := make([]byte, syncproto.SessionIDSize)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	sess := &session{
		srv:     s,
		ctx:     ctx,
		cancel:  cancel,
		node:    node,
		addr:    addr,
		key:     key,
		id:      id,
		out:     make(chan *syncv1.ServerFrame, s.opts.QueueSize),
		started: time.Now(),
		log:     logger.With(slog.String("session", hex.EncodeToString(id))),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errShutdown
	}
	for other := range s.sessions {
		if other.node == node {
			other.cancel(errSuperseded)
		}
	}
	s.sessions[sess] = struct{}{}
	s.nodes[node].sessions++
	return sess, nil
}

func (s *Server) closeSession(sess *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sess)
}

func (s *Server) recordAck(node string, revision uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.nodes[node]
	if revision > st.acked {
		st.acked = revision
	}
	st.lastAck = time.Now()
}

func (s *Server) recordSnapshot(node string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes[node].snapshots++
}

func (s *Server) recordSent(node string, revision uint64, fp string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.nodes[node]
	st.sentRev, st.sentFP = revision, fp
}

func (s *Server) lastSent(node string) (uint64, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.nodes[node]
	return st.sentRev, st.sentFP
}

func (s *Server) recordResync(node, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.nodes[node]
	st.resyncReason, st.resyncAt = reason, time.Now()
}

func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for sess := range s.sessions {
		sess.cancel(errShutdown)
	}
}

func (s *Server) SessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

func (s *Server) Nodes() []NodeStatus {
	head := s.notify.Head()
	s.mu.Lock()
	defer s.mu.Unlock()
	live := map[string]*session{}
	for sess := range s.sessions {
		if cur, ok := live[sess.node]; !ok || sess.started.After(cur.started) {
			live[sess.node] = sess
		}
	}
	out := make([]NodeStatus, 0, len(s.nodes))
	for node, st := range s.nodes {
		ns := NodeStatus{Node: node, AckedRevision: st.acked, Sessions: st.sessions, Snapshots: st.snapshots, ResyncReason: st.resyncReason}
		if !st.resyncAt.IsZero() {
			t := st.resyncAt
			ns.ResyncAt = &t
		}
		if !st.lastAck.IsZero() {
			t := st.lastAck
			ns.LastAckAt = &t
		}
		if sess, ok := live[node]; ok {
			t := sess.started
			ns.Connected = true
			ns.Session = hex.EncodeToString(sess.id)
			ns.Peer = sess.addr
			ns.SentRevision = sess.sent.Load()
			ns.ConnectedAt = &t
		}
		if head > ns.AckedRevision {
			ns.Lag = head - ns.AckedRevision
		}
		out = append(out, ns)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	return out
}

func (s *Server) LogLag(ctx context.Context) {
	head := s.notify.Head()
	for _, n := range s.Nodes() {
		s.log.InfoContext(ctx, "sync node revision lag",
			slog.String("node", n.Node), slog.Bool("connected", n.Connected), slog.Uint64("head_revision", head),
			slog.Uint64("sent_revision", n.SentRevision), slog.Uint64("acked_revision", n.AckedRevision), slog.Uint64("lag", n.Lag))
	}
}

func (s *Server) RunLagLogger(ctx context.Context) {
	t := time.NewTicker(s.opts.LagLogInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.LogLag(ctx)
		}
	}
}
