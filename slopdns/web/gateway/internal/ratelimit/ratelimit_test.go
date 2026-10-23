package ratelimit

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCapacityFailsClosedWithoutEvictingBudgets(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(1, 1, func() time.Time { return now })
	l.maxBuckets = 2
	for _, key := range []string{"a", "b"} {
		if ok, _ := l.Allow(key); !ok {
			t.Fatal("initial request denied")
		}
	}
	for i := range 1000 {
		if ok, _ := l.Allow(fmt.Sprint(i)); ok {
			t.Fatal("capacity failed open")
		}
	}
	if l.Len() != 2 {
		t.Fatalf("map grew to %d", l.Len())
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("active bucket was reset")
	}
	now = now.Add(DefaultSweepInterval)
	if ok, _ := l.Allow("new"); !ok {
		t.Fatal("expired capacity was not reclaimed")
	}
}

func TestConcurrentBudget(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(1, 5, func() time.Time { return now })
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for range 100 {
		wg.Go(func() {
			if ok, _ := l.Allow("same"); ok {
				allowed.Add(1)
			}
		})
	}
	wg.Wait()
	if got := allowed.Load(); got != 5 {
		t.Fatalf("allowed %d concurrent requests", got)
	}
}

func TestRefillAndClockRollback(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(1, 1, func() time.Time { return now })
	l.Allow("a")
	now = now.Add(-time.Second)
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("clock rollback refilled bucket")
	}
	now = now.Add(time.Second)
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("clock rollback reset refill time")
	}
	now = now.Add(time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("refill denied")
	}
}
