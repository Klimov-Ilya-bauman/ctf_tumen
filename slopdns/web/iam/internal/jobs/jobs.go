package jobs

import (
	"context"
	"log/slog"
	"time"

	"slopdns/web/iam/internal/store"
)

const CleanupLockKey int64 = 0x534c4f5049414d31

type CleanupConfig struct {
	Interval          time.Duration
	RevokedRetention  time.Duration
	ExpiredRetention  time.Duration
	MFARetention      time.Duration
	RecoveryRetention time.Duration
}

func DefaultCleanupConfig() CleanupConfig {
	return CleanupConfig{
		Interval:          10 * time.Minute,
		RevokedRetention:  24 * time.Hour,
		ExpiredRetention:  7 * 24 * time.Hour,
		MFARetention:      time.Hour,
		RecoveryRetention: 30 * 24 * time.Hour,
	}
}

type Cleaner struct {
	store store.Store
	cfg   CleanupConfig
	log   *slog.Logger
	now   func() time.Time
}

func NewCleaner(s store.Store, cfg CleanupConfig, log *slog.Logger, now func() time.Time) *Cleaner {
	def := DefaultCleanupConfig()
	if cfg.Interval <= 0 {
		cfg.Interval = def.Interval
	}
	if cfg.RevokedRetention <= 0 {
		cfg.RevokedRetention = def.RevokedRetention
	}
	if cfg.ExpiredRetention <= 0 {
		cfg.ExpiredRetention = def.ExpiredRetention
	}
	if cfg.MFARetention <= 0 {
		cfg.MFARetention = def.MFARetention
	}
	if cfg.RecoveryRetention <= 0 {
		cfg.RecoveryRetention = def.RecoveryRetention
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if now == nil {
		now = time.Now
	}
	return &Cleaner{store: s, cfg: cfg, log: log, now: now}
}

func (c *Cleaner) RunOnce(ctx context.Context) (bool, store.CleanupResult, error) {
	var res store.CleanupResult
	policy := store.CleanupPolicy{
		Now:               c.now().UTC(),
		RevokedRetention:  c.cfg.RevokedRetention,
		ExpiredRetention:  c.cfg.ExpiredRetention,
		MFARetention:      c.cfg.MFARetention,
		RecoveryRetention: c.cfg.RecoveryRetention,
	}
	ran, err := c.store.WithTryLock(ctx, CleanupLockKey, func(tx store.Tx) error {
		var err error
		res, err = tx.Cleanup(ctx, policy)
		return err
	})
	return ran, res, err
}

func (c *Cleaner) Run(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.Interval)
	defer ticker.Stop()
	for {
		ran, res, err := c.RunOnce(ctx)
		switch {
		case err != nil && ctx.Err() == nil:
			c.log.WarnContext(ctx, "cleanup job failed", slog.Any("error", err))
		case !ran:
			c.log.DebugContext(ctx, "cleanup job skipped, lock held by another instance")
		case err == nil:
			c.log.InfoContext(ctx, "cleanup job finished", slog.Int64("sessions", res.Sessions), slog.Int64("mfa_challenges", res.MFAChallenges), slog.Int64("api_tokens", res.APITokens), slog.Int64("recovery_codes", res.RecoveryCodes))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
