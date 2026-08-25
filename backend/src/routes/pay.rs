use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};

use crate::extractors::ValidatedBody;
use crate::soroban::SorobanClient;
use crate::types::{ErrorResponse, PayRequest};

#[utoipa::path(
    post,
    path = "/invoices/{id}/pay",
    params(
        ("id" = u64, Path, description = "Invoice ID")
    ),
    request_body = PayRequest,
    responses(
        (status = 200, description = "Payment successful", body = serde_json::Value),
        (status = 403, description = "Payer not authorized", body = ErrorResponse),
        (status = 404, description = "Invoice not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "pay"
)]
pub async fn pay_invoice(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    ValidatedBody(body): ValidatedBody<PayRequest>,
) -> impl IntoResponse {
    // ── Idempotency check ────────────────────────────────────────────────────
    let idem_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref key) = idem_key {
        let store_key = IdempotencyStore::make_key("pay", id, key);
        if let Some(cached) = state.idempotency.get(&store_key) {
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, Json(cached.body)).into_response();
        }
    }

    // ── Process the payment ──────────────────────────────────────────────────
    let result = state.client.pay_invoice(id, &body.payer, &body.signed_xdr).await;

    let (status, body_json) = match result {
        Ok(resp) => (StatusCode::OK, serde_json::json!(resp)),
        Err(e) if e.to_string().contains("UNAUTHORIZED") => (
            StatusCode::FORBIDDEN,
            serde_json::json!(ErrorResponse {
                error: "Payer does not match the expected address for this invoice".to_string(),
                code: Some(1),
            }),
        ),
        Err(e) if e.to_string().contains("NOT_FOUND") => (
            StatusCode::NOT_FOUND,
            serde_json::json!(ErrorResponse {
                error: format!("Invoice {} not found", id),
                code: Some(6),
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!(ErrorResponse {
                error: e.to_string(),
                code: None,
            }),
        ),
    };

    // ── Cache the result ─────────────────────────────────────────────────────
    if let Some(ref key) = idem_key {
        let store_key = IdempotencyStore::make_key("pay", id, key);
        state.idempotency.insert(store_key, status.as_u16(), body_json.clone());
    }

    (status, Json(body_json)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idempotency::IdempotencyStore;
    use crate::routes::invoices::get_invoice;
    use crate::soroban::SorobanClient;
    use axum::{
        routing::{get, post},
        Router,
    };
    use axum_test::TestServer;
    use std::sync::Arc;
    use std::time::Duration;

    fn make_app() -> Router {
        let state = AppState {
            client: Arc::new(SorobanClient::new(
                "http://127.0.0.1:19999/soroban/rpc".to_string(),
                "CONTRACT_ID".to_string(),
                "https://horizon.stellar.org".to_string(),
            )),
            idempotency: IdempotencyStore::new(Duration::from_secs(86_400)),
        };
        Router::new()
            .route("/invoices/:id", get(get_invoice))
            .route("/invoices/:id/pay", post(pay_invoice))
            .with_state(state)
    }

    #[tokio::test]
    async fn test_pay_invoice_missing_body_returns_4xx() {
        let server = TestServer::new(make_app()).unwrap();
        let resp = server
            .post("/invoices/1/pay")
            .content_type("application/json")
            .bytes(axum::body::Bytes::new())
            .await;
        assert!(
            resp.status_code().is_client_error(),
            "missing body should return a 4xx, got {}",
            resp.status_code()
        );
        let app = make_app(client);
        let server = TestServer::new(app).unwrap();

        // No JSON body → 415 Unsupported Media Type (no Content-Type header)
        // or 422 Unprocessable Entity (JSON Content-Type but invalid body)
        let resp = server.post("/invoices/1/pay").await;
        assert!(
            resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code() == StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected 415 or 422, got {}",
            resp.status_code()
        );
    }

    #[tokio::test]
    async fn test_pay_invoice_malformed_body_returns_422() {
        let client = SorobanClient::new(
            "http://127.0.0.1:19999/soroban/rpc".to_string(),
            "CONTRACT_ID".to_string(),
            "https://horizon.stellar.org".to_string(),
        );
        let app = make_app(client);
        let server = TestServer::new(app).unwrap();

        // Malformed (non-JSON) body → 422 Unprocessable Entity
        let resp = server
            .post("/invoices/1/pay")
            .content_type("application/json")
            .bytes(axum::body::Bytes::from_static(b"not-valid-json{{"))
            .await;
        assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn test_pay_invoice_unreachable_rpc_returns_5xx_or_404() {
        let server = TestServer::new(make_app()).unwrap();
        let resp = server
            .post("/invoices/1/pay")
            .json(&serde_json::json!({
                "payer": "GPAYER0000000000000000000000000000000000000000000000000000",
                "signed_xdr": "AAAA=="
            }))
            .await;
        assert!(
            resp.status_code() == StatusCode::INTERNAL_SERVER_ERROR
                || resp.status_code() == StatusCode::NOT_FOUND
                || resp.status_code() == StatusCode::FORBIDDEN
        );
    }

    /// Same idempotency key on pay must return the cached response on retry.
    #[tokio::test]
    async fn test_same_idempotency_key_returns_cached_response() {
        let server = TestServer::new(make_app()).unwrap();
        let payload = serde_json::json!({
            "payer": "GPAYER0000000000000000000000000000000000000000000000000000",
            "signed_xdr": "AAAA=="
        });

        let resp1 = server
            .post("/invoices/1/pay")
            .add_header("Idempotency-Key".parse().unwrap(), "pay-key-abc".parse().unwrap())
            .json(&payload)
            .await;

        let status1 = resp1.status_code();
        let body1 = resp1.text();

        let resp2 = server
            .post("/invoices/1/pay")
            .add_header("Idempotency-Key".parse().unwrap(), "pay-key-abc".parse().unwrap())
            .json(&payload)
            .await;

        assert_eq!(resp2.status_code(), status1);
        assert_eq!(resp2.text(), body1);
    }
}
