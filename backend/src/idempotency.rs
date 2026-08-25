use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A cached response stored against an idempotency key.
#[derive(Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub body: serde_json::Value,
    pub recorded_at: Instant,
}

/// Shared in-memory idempotency store.
///
/// Keys are scoped as `"{endpoint}:{invoice_id}:{idempotency_key}"` so the same
/// `Idempotency-Key` header value used on two different endpoints never collides.
///
/// Entries are evicted lazily on lookup once their TTL has elapsed.
pub struct IdempotencyStore {
    inner: DashMap<String, CachedResponse>,
    ttl: Duration,
}

impl IdempotencyStore {
    /// Create a new store with the given TTL (recommended: 24 h for production,
    /// shorter for tests).
    pub fn new(ttl: Duration) -> Arc<Self> {
        Arc::new(Self {
            inner: DashMap::new(),
            ttl,
        })
    }

    /// Build the namespaced key used for storage lookups.
    pub fn make_key(endpoint: &str, invoice_id: u64, idempotency_key: &str) -> String {
        format!("{endpoint}:{invoice_id}:{idempotency_key}")
    }

    /// Return the cached response if the key exists and has not expired.
    pub fn get(&self, key: &str) -> Option<CachedResponse> {
        if let Some(entry) = self.inner.get(key) {
            if entry.recorded_at.elapsed() < self.ttl {
                return Some(entry.clone());
            }
            // Expired — evict lazily.
            drop(entry);
            self.inner.remove(key);
        }
        None
    }

    /// Insert a response into the store.
    pub fn insert(&self, key: String, status: u16, body: serde_json::Value) {
        self.inner.insert(
            key,
            CachedResponse {
                status,
                body,
                recorded_at: Instant::now(),
            },
        );
    }
}
