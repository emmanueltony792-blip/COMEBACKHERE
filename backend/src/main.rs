mod rate_limiter;
mod routes;
mod soroban;
mod types;

use axum::{routing::{get, post}, Router};
use std::sync::Arc;
use std::time::Duration;

use rate_limiter::{new_store, RateLimitConfig, RateLimiterLayer};
use routes::{
    cancel::cancel_invoice,
    health::get_rpc_health,
    invoices::get_invoice,
    pay::pay_invoice,
    refund::refund_invoice,
};
use soroban::SorobanClient;

#[utoipa::openapi(
    info(
        title = "COMEBACKHERE API",
        version = "0.1.0",
        description = "COMEBACKHERE backend API for invoice management"
    ),
    paths(
        routes::health::get_rpc_health,
        routes::invoices::get_invoice,
        routes::pay::pay_invoice,
        routes::cancel::cancel_invoice,
    ),
    tags(
        (name = "health", description = "Health check endpoints"),
        (name = "invoices", description = "Invoice management"),
        (name = "pay", description = "Payment operations"),
        (name = "cancel", description = "Cancellation operations")
    )
)]
struct ApiDoc;

#[tokio::main]
async fn main() {
    // Initialise structured logging.  Level is controlled at runtime via the
    // RUST_LOG environment variable (e.g. `RUST_LOG=info`).  Defaults to
    // `info` when the variable is absent.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let rpc_url = std::env::var("SOROBAN_RPC_URL")
        .unwrap_or_else(|_| "http://localhost:8000/soroban/rpc".to_string());
    let contract_id = std::env::var("INVOICE_CONTRACT_ID")
        .unwrap_or_else(|_| "CONTRACT_ID_PLACEHOLDER".to_string());
    let horizon_url = std::env::var("HORIZON_API_URL")
        .unwrap_or_else(|_| "https://horizon.stellar.org".to_string());

    let state = AppState {
        client: Arc::new(SorobanClient::new(rpc_url, contract_id, horizon_url)),
        // 24-hour TTL for idempotency keys (matches common API gateway defaults).
        idempotency: IdempotencyStore::new(Duration::from_secs(86_400)),
    };

    // Rate-limiter layer: config is read from RATE_LIMIT_POINTS / RATE_LIMIT_DURATION
    // (defaults: 60 requests per 60-second window, per IP).
    let rl_config = RateLimitConfig::from_env();
    let rl_layer = RateLimiterLayer::new(new_store(), rl_config);

    let app = Router::new()
        .route("/health/rpc", get(get_rpc_health))
        .route("/invoices/:id", get(get_invoice))
        .route("/invoices/:id/pay", post(pay_invoice))
        .route("/invoices/:id/cancel", post(cancel_invoice))
        .route("/invoices/:id/refund", post(refund_invoice))
        .layer(rl_layer)
        .with_state(client);

    let addr = "0.0.0.0:3001";
    tracing::info!("comebackhere-backend listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn openapi_json_returns_200_and_valid_json() {
        let app = Router::new()
            .route("/openapi.json", get(|| async { ApiDoc::openapi() }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/openapi.json"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(body.get("openapi").is_some());
        assert!(body.get("info").is_some());
        assert!(body.get("paths").is_some());
    }
}
