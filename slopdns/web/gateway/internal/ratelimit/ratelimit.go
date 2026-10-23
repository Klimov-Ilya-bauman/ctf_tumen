package ratelimit

import (
	"math"
	"sync"
	"time"
)

const DefaultSweepInterval = time.Minute

// Bound memory even when many distinct clients arrive between sweeps.
const DefaultMaxBuckets = 65536

type bucket struct {
	tokens float64
	last   time.Time
}

type Limiter struct {
	mu         sync.Mutex
	maxBuckets int
	rate       float64
	burst      float64
	idle       time.Duration
	sweepEvery time.Duration
	lastSweep  time.Time
	now        func() time.Time
	buckets    map[string]*bucket
}

func New(rps float64, burst int, now func() time.Time) *Limiter {
	if rps <= 0 || math.IsNaN(rps) || math.IsInf(rps, 0) {
		rps = 1
	}
	if burst < 1 {
		burst = 1
	}
	if now == nil {
		now = time.Now
	}
	refill := time.Duration(math.Ceil(float64(burst) / rps * float64(time.Second)))
	return &Limiter{
		maxBuckets: DefaultMaxBuckets,
		rate:       rps,
		burst:      float64(burst),
		idle:       refill + time.Second,
		sweepEvery: DefaultSweepInterval,
		lastSweep:  now(),
		now:        now,
		buckets:    map[string]*bucket{},
	}
}

func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	b, ok := l.buckets[key]
	if !ok {
		// Do not evict active buckets: that would reset an attacker's budget.
		if len(l.buckets) >= l.maxBuckets {
			return false, l.sweepEvery
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed.Seconds()*l.rate)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

func (l *Limiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.sweepEvery {
		return
	}
	l.lastSweep = now
	for k, b := range l.buckets {
		if now.Sub(b.last) >= l.idle {
			delete(l.buckets, k)
		}
	}
}

func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

func RetryAfterSeconds(wait time.Duration) int {
	s := int(math.Ceil(wait.Seconds()))
	if s < 1 {
		return 1
	}
	return s
}
