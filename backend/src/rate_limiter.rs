//! Per-IP sliding-window rate limiter implemented as a `tower::Layer`.
//!
//! Mirrors the behaviour of the TypeScript `middleware/rateLimiter.ts`:
//! - Configurable via `RATE_LIMIT_POINTS` (max requests) and
//!   `RATE_LIMIT_DURATION` (window in seconds), defaulting to 60/60.
//! - Returns **429 Too Many Requests** with a `Retry-After` header and a
//!   JSON body `{ "error": "…", "retryAfter": <seconds> }` when the limit
//!   is exceeded.
//! - Uses the `X-Forwarded-For` header (first IP in the list) when present,
//!   falling back to the peer socket address.

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::json;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

// ─── Configuration ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    /// Maximum number of requests allowed per `window`.
    pub max_requests: u64,
    /// Rolling window duration.
    pub window: Duration,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests: 60,
            window: Duration::from_secs(60),
        }
    }
}

impl RateLimitConfig {
    /// Read configuration from the `RATE_LIMIT_POINTS` / `RATE_LIMIT_DURATION`
    /// environment variables, falling back to 60 req / 60 s.
    pub fn from_env() -> Self {
        let max_requests = std::env::var("RATE_LIMIT_POINTS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);
        let secs = std::env::var("RATE_LIMIT_DURATION")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);
        Self {
            max_requests,
            window: Duration::from_secs(secs),
        }
    }
}

// ─── Per-IP bucket ──────────────────────────────────────────────────────────

#[derive(Debug)]
struct Bucket {
    /// Timestamps of requests that fall inside the current window.
    timestamps: Vec<Instant>,
}

impl Bucket {
    fn new() -> Self {
        Self {
            timestamps: Vec::new(),
        }
    }

    /// Purges stale entries, records this request, and returns whether the
    /// request is allowed together with the time until a slot frees up
    /// (used for `Retry-After`).
    fn check_and_record(&mut self, now: Instant, window: Duration, max: u64) -> (bool, Duration) {
        self.timestamps.retain(|&t| now.duration_since(t) < window);

        if self.timestamps.len() as u64 >= max {
            let retry_after = self.timestamps[0]
                .checked_add(window)
                .map(|expiry| expiry.saturating_duration_since(now))
                .unwrap_or(window);
            (false, retry_after)
        } else {
            self.timestamps.push(now);
            (true, Duration::ZERO)
        }
    }
}

// ─── Shared state ───────────────────────────────────────────────────────────

/// Opaque handle to the shared per-IP bucket store.
#[derive(Debug, Clone)]
pub struct RateLimiterStore(Arc<Mutex<HashMap<String, Bucket>>>);

pub fn new_store() -> RateLimiterStore {
    RateLimiterStore(Arc::new(Mutex::new(HashMap::new())))
}

// ─── Layer ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RateLimiterLayer {
    store: RateLimiterStore,
    config: RateLimitConfig,
}

impl RateLimiterLayer {
    pub fn new(store: RateLimiterStore, config: RateLimitConfig) -> Self {
        Self { store, config }
    }
}

impl<S> tower::Layer<S> for RateLimiterLayer {
    type Service = RateLimiterMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimiterMiddleware {
            inner,
            store: self.store.clone(),
            config: self.config,
        }
    }
}

// ─── Service ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RateLimiterMiddleware<S> {
    inner: S,
    store: RateLimiterStore,
    config: RateLimitConfig,
}

impl<S> tower::Service<Request<Body>> for RateLimiterMiddleware<S>
where
    S: tower::Service<Request<Body>, Response = Response<Body>> + Send + Clone + 'static,
    S::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let ip = extract_ip(&req);

        let now = Instant::now();
        let config = self.config;
        let allowed;
        let retry_after_secs;

        {
            let mut store = self.store.0.lock().expect("rate limiter lock poisoned");
            let bucket = store.entry(ip).or_insert_with(Bucket::new);
            let (ok, retry) = bucket.check_and_record(now, config.window, config.max_requests);
            allowed = ok;
            retry_after_secs = retry.as_secs().max(1);
        }

        if allowed {
            let fut = self.inner.call(req);
            Box::pin(async move { fut.await })
        } else {
            Box::pin(async move { Ok(build_rate_limit_response(retry_after_secs)) })
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn extract_ip<B>(req: &Request<B>) -> String {
    if let Some(forwarded) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first) = forwarded.split(',').next() {
            let trimmed = first.trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }

    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn build_rate_limit_response(retry_after_secs: u64) -> Response<Body> {
    let body = json!({
        "error": "Too many requests. Please retry after the indicated number of seconds.",
        "retryAfter": retry_after_secs,
    });
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("retry-after", retry_after_secs.to_string())],
        Json(body),
    )
        .into_response()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use axum_test::TestServer;

    fn make_server(max_requests: u64, window_secs: u64) -> TestServer {
        let config = RateLimitConfig {
            max_requests,
            window: Duration::from_secs(window_secs),
        };
        let store = new_store();
        let layer = RateLimiterLayer::new(store, config);
        let app = Router::new()
            .route("/ping", get(|| async { "pong" }))
            .layer(layer);
        TestServer::new(app).expect("test server should start")
    }

    // ── 429 on exceed ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_requests_within_limit_are_allowed() {
        let server = make_server(3, 60);
        for _ in 0..3 {
            let resp = server.get("/ping").await;
            assert_ne!(
                resp.status_code(),
                StatusCode::TOO_MANY_REQUESTS,
                "request within limit should not be rate-limited"
            );
        }
    }

    #[tokio::test]
    async fn test_request_beyond_limit_returns_429() {
        let server = make_server(2, 60);
        server.get("/ping").await;
        server.get("/ping").await;
        let resp = server.get("/ping").await;
        assert_eq!(resp.status_code(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn test_429_response_has_retry_after_header() {
        let server = make_server(1, 60);
        server.get("/ping").await; // consume the single allowed request
        let resp = server.get("/ping").await;
        assert_eq!(resp.status_code(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after = resp
            .headers()
            .get("retry-after")
            .expect("Retry-After header must be present")
            .to_str()
            .expect("Retry-After must be valid ASCII");
        let secs: u64 = retry_after.parse().expect("Retry-After must be a number");
        assert!(secs > 0, "Retry-After must be > 0");
    }

    #[tokio::test]
    async fn test_429_response_body_contains_error_and_retry_after() {
        let server = make_server(1, 60);
        server.get("/ping").await;
        let resp = server.get("/ping").await;
        assert_eq!(resp.status_code(), StatusCode::TOO_MANY_REQUESTS);
        let body: serde_json::Value = resp.json();
        assert!(
            body["error"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("too many requests"),
            "body.error should mention 'too many requests'"
        );
        assert!(
            body["retryAfter"].as_u64().unwrap_or(0) > 0,
            "body.retryAfter must be > 0"
        );
    }

    // ── Reset after window ───────────────────────────────────────────────────

    #[tokio::test]
    async fn test_limit_resets_after_window_expires() {
        // 200 ms window so the test completes quickly.
        let config = RateLimitConfig {
            max_requests: 1,
            window: Duration::from_millis(200),
        };
        let store = new_store();
        let layer = RateLimiterLayer::new(store, config);
        let app = Router::new()
            .route("/ping", get(|| async { "pong" }))
            .layer(layer);
        let server = TestServer::new(app).expect("test server should start");

        // Use the 1-request allowance.
        let resp1 = server.get("/ping").await;
        assert_ne!(resp1.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // Second request in the same window is blocked.
        let resp2 = server.get("/ping").await;
        assert_eq!(resp2.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // Wait for the window to expire.
        tokio::time::sleep(Duration::from_millis(250)).await;

        // After the window resets, the request should be allowed again.
        let resp3 = server.get("/ping").await;
        assert_ne!(
            resp3.status_code(),
            StatusCode::TOO_MANY_REQUESTS,
            "limit should reset after the window expires"
        );
    }

    #[tokio::test]
    async fn test_x_forwarded_for_used_for_ip_key() {
        // Limit: 1 request / 60 s. Each IP has its own independent bucket.
        let config = RateLimitConfig {
            max_requests: 1,
            window: Duration::from_secs(60),
        };
        let store = new_store();
        let layer = RateLimiterLayer::new(store, config);
        let app = Router::new()
            .route("/ping", get(|| async { "pong" }))
            .layer(layer);
        let server = TestServer::new(app).expect("test server should start");

        use axum::http::header::{HeaderName, HeaderValue};
        let xff = HeaderName::from_static("x-forwarded-for");

        // IP A uses its allowance.
        let resp_a1 = server
            .get("/ping")
            .add_header(xff.clone(), HeaderValue::from_static("1.2.3.4"))
            .await;
        assert_ne!(resp_a1.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // IP A is now blocked.
        let resp_a2 = server
            .get("/ping")
            .add_header(xff.clone(), HeaderValue::from_static("1.2.3.4"))
            .await;
        assert_eq!(resp_a2.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // IP B still has its own fresh allowance.
        let resp_b = server
            .get("/ping")
            .add_header(xff.clone(), HeaderValue::from_static("5.6.7.8"))
            .await;
        assert_ne!(
            resp_b.status_code(),
            StatusCode::TOO_MANY_REQUESTS,
            "different IP should have its own independent bucket"
        );
    }
}
