package lru

import (
	"container/list"
	"sync"
	"time"
)

type item[K comparable, V any] struct {
	key     K
	value   V
	expires time.Time
}

type Cache[K comparable, V any] struct {
	mu    sync.Mutex
	ll    *list.List
	items map[K]*list.Element
	size  int
	ttl   time.Duration
	now   func() time.Time
}

func New[K comparable, V any](size int, ttl time.Duration) *Cache[K, V] {
	if size <= 0 {
		size = 1
	}
	return &Cache[K, V]{ll: list.New(), items: map[K]*list.Element{}, size: size, ttl: ttl, now: time.Now}
}

func (c *Cache[K, V]) SetClock(now func() time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

func (c *Cache[K, V]) Get(k K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[k]
	if !ok {
		var zero V
		return zero, false
	}
	it := el.Value.(*item[K, V])
	if c.ttl > 0 && !c.now().Before(it.expires) {
		c.ll.Remove(el)
		delete(c.items, k)
		var zero V
		return zero, false
	}
	c.ll.MoveToFront(el)
	return it.value, true
}

func (c *Cache[K, V]) Put(k K, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	exp := c.now().Add(c.ttl)
	if el, ok := c.items[k]; ok {
		it := el.Value.(*item[K, V])
		it.value, it.expires = v, exp
		c.ll.MoveToFront(el)
		return
	}
	c.items[k] = c.ll.PushFront(&item[K, V]{key: k, value: v, expires: exp})
	for c.ll.Len() > c.size {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.items, last.Value.(*item[K, V]).key)
	}
}

func (c *Cache[K, V]) Delete(k K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[k]; ok {
		c.ll.Remove(el)
		delete(c.items, k)
	}
}

func (c *Cache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
