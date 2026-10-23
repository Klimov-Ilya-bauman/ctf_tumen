package hub

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	DefaultChannel      = "slopdns_changes"
	DefaultPollInterval = 2 * time.Second
	ApplicationName     = "dns-sync-listen"
)

var ErrNotListening = errors.New("hub: LISTEN connection is not active")

type HeadReader interface {
	Head(ctx context.Context) (uint64, error)
}

type Options struct {
	DSN          string
	Channel      string
	PollInterval time.Duration
	BackoffMin   time.Duration
	BackoffMax   time.Duration
	Logger       *slog.Logger
}

type Stats struct {
	Head          uint64 `json:"head_revision"`
	Listening     bool   `json:"listening"`
	Notifications uint64 `json:"notifications"`
	Reconnects    uint64 `json:"listen_reconnects"`
}

type Hub struct {
	src           HeadReader
	opts          Options
	mu            sync.Mutex
	head          uint64
	wake          chan struct{}
	listening     atomic.Bool
	notifications atomic.Uint64
	reconnects    atomic.Uint64
	connected     atomic.Uint64
}

func New(src HeadReader, opts Options) *Hub {
	if opts.Channel == "" {
		opts.Channel = DefaultChannel
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = DefaultPollInterval
	}
	if opts.BackoffMin <= 0 {
		opts.BackoffMin = 100 * time.Millisecond
	}
	if opts.BackoffMax < opts.BackoffMin {
		opts.BackoffMax = 5 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Hub{src: src, opts: opts, wake: make(chan struct{})}
}

func (h *Hub) Head() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.head
}

func (h *Hub) Changed() <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.wake
}

func (h *Hub) Advance(head uint64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if head == h.head {
		return false
	}
	h.head = head
	close(h.wake)
	h.wake = make(chan struct{})
	return true
}

func (h *Hub) Refresh(ctx context.Context) error {
	head, err := h.src.Head(ctx)
	if err != nil {
		return err
	}
	if prev := h.Head(); head < prev {
		h.opts.Logger.ErrorContext(ctx, "change_log head went backwards, the database was reset or restored", slog.Uint64("previous_head", prev), slog.Uint64("head", head))
	}
	h.Advance(head)
	return nil
}

func (h *Hub) Listening() bool {
	return h.listening.Load()
}

func (h *Hub) Check(context.Context) error {
	if !h.listening.Load() {
		return ErrNotListening
	}
	return nil
}

func (h *Hub) Stats() Stats {
	return Stats{Head: h.Head(), Listening: h.listening.Load(), Notifications: h.notifications.Load(), Reconnects: h.reconnects.Load()}
}

func (h *Hub) Run(ctx context.Context) {
	if err := h.Refresh(ctx); err != nil && ctx.Err() == nil {
		h.opts.Logger.WarnContext(ctx, "initial change_log read failed", slog.Any("error", err))
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		h.poll(ctx)
	}()
	go func() {
		defer wg.Done()
		h.listen(ctx)
	}()
	wg.Wait()
}

func (h *Hub) poll(ctx context.Context) {
	t := time.NewTicker(h.opts.PollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := h.Refresh(ctx); err != nil && ctx.Err() == nil {
				h.opts.Logger.WarnContext(ctx, "change_log poll failed", slog.Any("error", err))
			}
		}
	}
}

func (h *Hub) listen(ctx context.Context) {
	backoff := h.opts.BackoffMin
	for ctx.Err() == nil {
		started := time.Now()
		err := h.listenOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		h.opts.Logger.WarnContext(ctx, "LISTEN connection lost", slog.String("channel", h.opts.Channel), slog.Any("error", err), slog.Duration("retry_in", backoff))
		if time.Since(started) > h.opts.BackoffMax {
			backoff = h.opts.BackoffMin
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, h.opts.BackoffMax)
	}
}

func (h *Hub) listenOnce(ctx context.Context) error {
	cfg, err := pgx.ParseConfig(h.opts.DSN)
	if err != nil {
		return errors.New("hub: invalid connection string")
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = ApplicationName
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		h.listening.Store(false)
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{h.opts.Channel}.Sanitize()); err != nil {
		return err
	}
	if h.connected.Add(1) > 1 {
		h.reconnects.Add(1)
	}
	h.listening.Store(true)
	h.opts.Logger.InfoContext(ctx, "listening for change notifications", slog.String("channel", h.opts.Channel))
	if err := h.Refresh(ctx); err != nil {
		h.opts.Logger.WarnContext(ctx, "change_log read after LISTEN failed", slog.Any("error", err))
	}
	for {
		if _, err := conn.WaitForNotification(ctx); err != nil {
			return err
		}
		h.notifications.Add(1)
		if err := h.Refresh(ctx); err != nil && ctx.Err() == nil {
			h.opts.Logger.WarnContext(ctx, "change_log read after notification failed", slog.Any("error", err))
		}
	}
}
