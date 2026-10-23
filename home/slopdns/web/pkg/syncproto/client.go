package syncproto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/pkg/dnsdata"
)

type ClientStream interface {
	Send(*syncv1.ClientFrame) error
	Recv() (*syncv1.ServerFrame, error)
}

type Client struct {
	stream    ClientStream
	nodeKey   ed25519.PrivateKey
	serverKey ed25519.PublicKey
	nonce     []byte
	session   []byte
}

type Snapshot struct {
	Revision uint64
	Zones    []*syncv1.Zone
	Digest   []byte
	Chunks   int
}

var ErrProtocol = errors.New("syncproto: protocol violation")

func NewClient(stream ClientStream, nodeKey ed25519.PrivateKey, serverKey ed25519.PublicKey) *Client {
	return &Client{stream: stream, nodeKey: nodeKey, serverKey: serverKey}
}

func (c *Client) Session() []byte {
	return append([]byte(nil), c.session...)
}

func (c *Client) Nonce() []byte {
	return append([]byte(nil), c.nonce...)
}

func (c *Client) Hello(nodeID string, lastRevision uint64) error {
	nonce := make([]byte, NonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	return c.SendHello(&syncv1.Hello{NodeId: nodeID, LastRevision: lastRevision, Nonce: nonce, ProtoVersion: ProtoVersion})
}

func (c *Client) SendHello(h *syncv1.Hello) error {
	c.nonce = append([]byte(nil), h.GetNonce()...)
	f, err := SignClient(c.nodeKey, syncv1.FrameKind_FRAME_KIND_HELLO, nil, h)
	if err != nil {
		return err
	}
	return c.stream.Send(f)
}

func (c *Client) Welcome() (*syncv1.Welcome, error) {
	kind, body, err := c.Next()
	if err != nil {
		return nil, err
	}
	w, ok := body.(*syncv1.Welcome)
	if !ok {
		return nil, fmt.Errorf("%w: expected welcome, got %s", ErrProtocol, kind)
	}
	if !bytes.Equal(w.GetClientNonce(), c.nonce) {
		return nil, fmt.Errorf("%w: welcome does not echo the hello nonce", ErrProtocol)
	}
	if len(w.GetSessionId()) != SessionIDSize {
		return nil, fmt.Errorf("%w: session id length %d", ErrProtocol, len(w.GetSessionId()))
	}
	if w.GetProtoVersion() != ProtoVersion {
		return nil, fmt.Errorf("%w: proto version %d", ErrProtocol, w.GetProtoVersion())
	}
	c.session = append([]byte(nil), w.GetSessionId()...)
	return w, nil
}

func (c *Client) Next() (syncv1.FrameKind, proto.Message, error) {
	f, err := c.stream.Recv()
	if err != nil {
		return syncv1.FrameKind_FRAME_KIND_UNSPECIFIED, nil, err
	}
	kind, _, err := UnwrapServer(f)
	if err != nil {
		return kind, nil, err
	}
	if kind != syncv1.FrameKind_FRAME_KIND_WELCOME && c.session == nil {
		return kind, nil, fmt.Errorf("%w: %s before welcome", ErrProtocol, kind)
	}
	return OpenServer(c.serverKey, c.session, f)
}

func (c *Client) NextSkippingHeartbeats() (syncv1.FrameKind, proto.Message, error) {
	for {
		kind, body, err := c.Next()
		if err != nil || kind != syncv1.FrameKind_FRAME_KIND_HEARTBEAT {
			return kind, body, err
		}
	}
}

func (c *Client) Ack(revision uint64) error {
	if c.session == nil {
		return fmt.Errorf("%w: ack before welcome", ErrProtocol)
	}
	f, err := SignClient(c.nodeKey, syncv1.FrameKind_FRAME_KIND_ACK, c.session, &syncv1.Ack{Revision: revision})
	if err != nil {
		return err
	}
	return c.stream.Send(f)
}

func (c *Client) ReadSnapshot(begin *syncv1.SnapshotBegin) (*Snapshot, error) {
	snap := &Snapshot{Revision: begin.GetRevision()}
	for {
		kind, body, err := c.NextSkippingHeartbeats()
		if err != nil {
			return nil, err
		}
		switch m := body.(type) {
		case *syncv1.SnapshotChunk:
			if m.GetRevision() != snap.Revision {
				return nil, fmt.Errorf("%w: chunk revision %d, snapshot %d", ErrProtocol, m.GetRevision(), snap.Revision)
			}
			snap.Chunks++
			snap.Zones = append(snap.Zones, m.GetZones()...)
		case *syncv1.SnapshotEnd:
			if m.GetRevision() != snap.Revision {
				return nil, fmt.Errorf("%w: end revision %d, snapshot %d", ErrProtocol, m.GetRevision(), snap.Revision)
			}
			if uint64(len(snap.Zones)) != uint64(begin.GetZoneCount()) {
				return nil, fmt.Errorf("%w: received %d zones, announced %d", ErrProtocol, len(snap.Zones), begin.GetZoneCount())
			}
			want := dnsdata.Digest(snap.Zones)
			if !bytes.Equal(want[:], m.GetDigest()) {
				return nil, fmt.Errorf("%w: snapshot digest mismatch", ErrProtocol)
			}
			snap.Digest = m.GetDigest()
			return snap, nil
		default:
			return nil, fmt.Errorf("%w: unexpected %s inside snapshot", ErrProtocol, kind)
		}
	}
}

func (c *Client) ExpectSnapshot() (*Snapshot, error) {
	kind, body, err := c.NextSkippingHeartbeats()
	if err != nil {
		return nil, err
	}
	begin, ok := body.(*syncv1.SnapshotBegin)
	if !ok {
		return nil, fmt.Errorf("%w: expected snapshot_begin, got %s", ErrProtocol, kind)
	}
	return c.ReadSnapshot(begin)
}

func (c *Client) ExpectDelta() (*syncv1.Delta, error) {
	kind, body, err := c.NextSkippingHeartbeats()
	if err != nil {
		return nil, err
	}
	d, ok := body.(*syncv1.Delta)
	if !ok {
		return nil, fmt.Errorf("%w: expected delta, got %s", ErrProtocol, kind)
	}
	return d, nil
}
