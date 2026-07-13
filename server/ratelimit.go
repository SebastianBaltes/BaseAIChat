package aichat

import (
	"sync"
	"time"
)

// rateLimiter is a fixed-window counter per client key. It is deliberately
// simple: the proxy sits in front of a paid API, so the goal is to blunt
// runaway loops and obvious abuse, not to be a precise traffic shaper.
type rateLimiter struct {
	max    int
	window time.Duration

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
	// now is injectable so tests do not have to sleep.
	now func() time.Time
}

type bucket struct {
	count       int
	windowStart time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		max:     max,
		window:  window,
		buckets: make(map[string]*bucket),
		now:     time.Now,
	}
}

// allow records one request for key and reports whether it stays within budget.
func (rl *rateLimiter) allow(key string) bool {
	if rl == nil || rl.max <= 0 {
		return true
	}
	now := rl.now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Sweep expired buckets at most once per window so the map cannot grow
	// without bound across many distinct clients.
	if now.Sub(rl.lastSweep) >= rl.window {
		for k, b := range rl.buckets {
			if now.Sub(b.windowStart) >= rl.window {
				delete(rl.buckets, k)
			}
		}
		rl.lastSweep = now
	}

	b, ok := rl.buckets[key]
	if !ok || now.Sub(b.windowStart) >= rl.window {
		rl.buckets[key] = &bucket{count: 1, windowStart: now}
		return true
	}
	b.count++
	return b.count <= rl.max
}
