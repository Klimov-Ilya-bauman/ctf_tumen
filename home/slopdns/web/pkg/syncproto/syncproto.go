package syncproto

import (
	"crypto/ed25519"
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"
)

const (
	ProtoVersion   = 1
	SessionIDSize  = 16
	NonceSize      = 16
	MaxMessageSize = 16 << 20
	ChunkTarget    = 1 << 20
	SignatureSize  = ed25519.SignatureSize
)

var (
	ErrBadSignature = errors.New("syncproto: invalid signature")
	ErrBadSession   = errors.New("syncproto: session id must be 16 bytes")
	ErrBadFrame     = errors.New("syncproto: unknown frame kind")
)

var signingContext = [16]byte{'s', 'l', 'o', 'p', 'd', 'n', 's', '-', 's', 'y', 'n', 'c', '-', 'v', '1', 0}

var zeroSession = make([]byte, SessionIDSize)

func Context() []byte {
	return append([]byte(nil), signingContext[:]...)
}

func ZeroSession() []byte {
	return append([]byte(nil), zeroSession...)
}

func SessionFor(kind syncv1.FrameKind, session []byte) []byte {
	if kind == syncv1.FrameKind_FRAME_KIND_HELLO || kind == syncv1.FrameKind_FRAME_KIND_WELCOME {
		return zeroSession
	}
	return session
}

func kindByte(kind syncv1.FrameKind) (byte, error) {
	if kind <= syncv1.FrameKind_FRAME_KIND_UNSPECIFIED || kind > syncv1.FrameKind_FRAME_KIND_HEARTBEAT {
		return 0, ErrBadFrame
	}
	return byte(kind), nil
}

func SignedMessage(kind syncv1.FrameKind, session, payload []byte) ([]byte, error) {
	k, err := kindByte(kind)
	if err != nil {
		return nil, err
	}
	if len(session) != SessionIDSize {
		return nil, ErrBadSession
	}
	out := make([]byte, 0, len(signingContext)+1+SessionIDSize+len(payload))
	out = append(out, signingContext[:]...)
	out = append(out, k)
	out = append(out, session...)
	return append(out, payload...), nil
}

func SignPayload(key ed25519.PrivateKey, kind syncv1.FrameKind, session, payload []byte) (*syncv1.Signed, error) {
	if len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("syncproto: invalid Ed25519 private key")
	}
	msg, err := SignedMessage(kind, session, payload)
	if err != nil {
		return nil, err
	}
	return &syncv1.Signed{Payload: payload, Signature: ed25519.Sign(key, msg)}, nil
}

func Sign(key ed25519.PrivateKey, kind syncv1.FrameKind, session []byte, body proto.Message) (*syncv1.Signed, error) {
	payload, err := proto.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("syncproto: marshal: %w", err)
	}
	return SignPayload(key, kind, session, payload)
}

func Verify(pub ed25519.PublicKey, kind syncv1.FrameKind, session []byte, s *syncv1.Signed) error {
	if s == nil || len(pub) != ed25519.PublicKeySize || len(s.GetSignature()) != SignatureSize {
		return ErrBadSignature
	}
	msg, err := SignedMessage(kind, session, s.GetPayload())
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, msg, s.GetSignature()) {
		return ErrBadSignature
	}
	return nil
}

func Open(pub ed25519.PublicKey, kind syncv1.FrameKind, session []byte, s *syncv1.Signed, body proto.Message) error {
	if err := Verify(pub, kind, session, s); err != nil {
		return err
	}
	if err := proto.Unmarshal(s.GetPayload(), body); err != nil {
		return fmt.Errorf("syncproto: decode payload: %w", err)
	}
	return nil
}

func NewBody(kind syncv1.FrameKind) (proto.Message, error) {
	switch kind {
	case syncv1.FrameKind_FRAME_KIND_HELLO:
		return &syncv1.Hello{}, nil
	case syncv1.FrameKind_FRAME_KIND_ACK:
		return &syncv1.Ack{}, nil
	case syncv1.FrameKind_FRAME_KIND_WELCOME:
		return &syncv1.Welcome{}, nil
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_BEGIN:
		return &syncv1.SnapshotBegin{}, nil
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_CHUNK:
		return &syncv1.SnapshotChunk{}, nil
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_END:
		return &syncv1.SnapshotEnd{}, nil
	case syncv1.FrameKind_FRAME_KIND_DELTA:
		return &syncv1.Delta{}, nil
	case syncv1.FrameKind_FRAME_KIND_HEARTBEAT:
		return &syncv1.Heartbeat{}, nil
	}
	return nil, ErrBadFrame
}

func WrapServer(kind syncv1.FrameKind, s *syncv1.Signed) (*syncv1.ServerFrame, error) {
	f := &syncv1.ServerFrame{}
	switch kind {
	case syncv1.FrameKind_FRAME_KIND_WELCOME:
		f.Kind = &syncv1.ServerFrame_Welcome{Welcome: s}
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_BEGIN:
		f.Kind = &syncv1.ServerFrame_SnapshotBegin{SnapshotBegin: s}
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_CHUNK:
		f.Kind = &syncv1.ServerFrame_SnapshotChunk{SnapshotChunk: s}
	case syncv1.FrameKind_FRAME_KIND_SNAPSHOT_END:
		f.Kind = &syncv1.ServerFrame_SnapshotEnd{SnapshotEnd: s}
	case syncv1.FrameKind_FRAME_KIND_DELTA:
		f.Kind = &syncv1.ServerFrame_Delta{Delta: s}
	case syncv1.FrameKind_FRAME_KIND_HEARTBEAT:
		f.Kind = &syncv1.ServerFrame_Heartbeat{Heartbeat: s}
	default:
		return nil, ErrBadFrame
	}
	return f, nil
}

func UnwrapServer(f *syncv1.ServerFrame) (syncv1.FrameKind, *syncv1.Signed, error) {
	switch k := f.GetKind().(type) {
	case *syncv1.ServerFrame_Welcome:
		return syncv1.FrameKind_FRAME_KIND_WELCOME, k.Welcome, nil
	case *syncv1.ServerFrame_SnapshotBegin:
		return syncv1.FrameKind_FRAME_KIND_SNAPSHOT_BEGIN, k.SnapshotBegin, nil
	case *syncv1.ServerFrame_SnapshotChunk:
		return syncv1.FrameKind_FRAME_KIND_SNAPSHOT_CHUNK, k.SnapshotChunk, nil
	case *syncv1.ServerFrame_SnapshotEnd:
		return syncv1.FrameKind_FRAME_KIND_SNAPSHOT_END, k.SnapshotEnd, nil
	case *syncv1.ServerFrame_Delta:
		return syncv1.FrameKind_FRAME_KIND_DELTA, k.Delta, nil
	case *syncv1.ServerFrame_Heartbeat:
		return syncv1.FrameKind_FRAME_KIND_HEARTBEAT, k.Heartbeat, nil
	}
	return syncv1.FrameKind_FRAME_KIND_UNSPECIFIED, nil, ErrBadFrame
}

func WrapClient(kind syncv1.FrameKind, s *syncv1.Signed) (*syncv1.ClientFrame, error) {
	switch kind {
	case syncv1.FrameKind_FRAME_KIND_HELLO:
		return &syncv1.ClientFrame{Kind: &syncv1.ClientFrame_Hello{Hello: s}}, nil
	case syncv1.FrameKind_FRAME_KIND_ACK:
		return &syncv1.ClientFrame{Kind: &syncv1.ClientFrame_Ack{Ack: s}}, nil
	}
	return nil, ErrBadFrame
}

func UnwrapClient(f *syncv1.ClientFrame) (syncv1.FrameKind, *syncv1.Signed, error) {
	switch k := f.GetKind().(type) {
	case *syncv1.ClientFrame_Hello:
		return syncv1.FrameKind_FRAME_KIND_HELLO, k.Hello, nil
	case *syncv1.ClientFrame_Ack:
		return syncv1.FrameKind_FRAME_KIND_ACK, k.Ack, nil
	}
	return syncv1.FrameKind_FRAME_KIND_UNSPECIFIED, nil, ErrBadFrame
}

func SignServer(key ed25519.PrivateKey, kind syncv1.FrameKind, session []byte, body proto.Message) (*syncv1.ServerFrame, error) {
	s, err := Sign(key, kind, SessionFor(kind, session), body)
	if err != nil {
		return nil, err
	}
	return WrapServer(kind, s)
}

func SignClient(key ed25519.PrivateKey, kind syncv1.FrameKind, session []byte, body proto.Message) (*syncv1.ClientFrame, error) {
	s, err := Sign(key, kind, SessionFor(kind, session), body)
	if err != nil {
		return nil, err
	}
	return WrapClient(kind, s)
}

func OpenServer(pub ed25519.PublicKey, session []byte, f *syncv1.ServerFrame) (syncv1.FrameKind, proto.Message, error) {
	kind, s, err := UnwrapServer(f)
	if err != nil {
		return kind, nil, err
	}
	body, err := NewBody(kind)
	if err != nil {
		return kind, nil, err
	}
	if err := Open(pub, kind, SessionFor(kind, session), s, body); err != nil {
		return kind, nil, err
	}
	return kind, body, nil
}

func OpenClient(pub ed25519.PublicKey, session []byte, f *syncv1.ClientFrame) (syncv1.FrameKind, proto.Message, error) {
	kind, s, err := UnwrapClient(f)
	if err != nil {
		return kind, nil, err
	}
	body, err := NewBody(kind)
	if err != nil {
		return kind, nil, err
	}
	if err := Open(pub, kind, SessionFor(kind, session), s, body); err != nil {
		return kind, nil, err
	}
	return kind, body, nil
}
