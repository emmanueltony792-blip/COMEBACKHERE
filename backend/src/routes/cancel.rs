use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};

use crate::extractors::ValidatedBody;
use crate::soroban::SorobanClient;
use crate::types::{CancelRequest, CancelResponse, ErrorResponse};

#[utoipa::path(
    post,
    path = "/invoices/{id}/cancel",
    params(
        ("id" = u64, Path, description = "Invoice ID")
    ),
    request_body = CancelRequest,
    responses(
        (status = 200, description = "Invoice cancelled", body = serde_json::Value),
        (status = 403, description = "Merchant not authorized", body = ErrorResponse),
        (status = 404, description = "Invoice not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "cancel"
)]
pub async fn cancel_invoice(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    ValidatedBody(body): ValidatedBody<CancelRequest>,
) -> impl IntoResponse {
    // ── Idempotency check ────────────────────────────────────────────────────
    let idem_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref key) = idem_key {
        let store_key = IdempotencyStore::make_key("cancel", id, key);
        if let Some(cached) = state.idempotency.get(&store_key) {
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, Json(cached.body)).into_response();
        }
    }

    // ── Process the cancellation ─────────────────────────────────────────────
    let result = state.client.cancel_invoice(id, &body.merchant, &body.signed_xdr).await;

    let (status, body_json) = match result {
        Ok(resp) => (StatusCode::OK, serde_json::json!(resp)),
        Err(e) if e.to_string().contains("UNAUTHORIZED") => (
            StatusCode::FORBIDDEN,
            serde_json::json!(ErrorResponse {
                error: "Only the invoice merchant is authorised to cancel this invoice"
                    .to_string(),
                code: Some(1),
            }),
        ),
        Err(e) if e.to_string().contains("NOT_FOUND") => (
            StatusCode::NOT_FOUND,
            serde_json::json!(ErrorResponse {
                error: format!("Invoice {} not found", id),
                code: Some(4),
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
        let store_key = IdempotencyStore::make_key("cancel", id, key);
        state.idempotency.insert(store_key, status.as_u16(), body_json.clone());
    }

    (status, Json(body_json)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idempotency::IdempotencyStore;
    use crate::routes::invoices::get_invoice;
    use crate::routes::pay::pay_invoice;
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
            .route("/invoices/:id/cancel", post(cancel_invoice))
            .with_state(state)
    }

    #[tokio::test]
    async fn test_cancel_invoice_missing_body_returns_422() {
        let client = SorobanClient::new(
            "http://127.0.0.1:19999/soroban/rpc".to_string(),
            "CONTRACT_ID".to_string(),
            "https://horizon.stellar.org".to_string(),
        );
        let app = make_app(client);
        let server = TestServer::new(app).unwrap();

        // No JSON body → 415 Unsupported Media Type (no Content-Type header)
        // or 422 Unprocessable Entity (JSON Content-Type but invalid body)
        let resp = server.post("/invoices/1/cancel").await;
        assert!(
            resp.status_code() == StatusCode::UNPROCESSABLE_ENTITY
                || resp.status_code() == StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected 415 or 422, got {}",
            resp.status_code()
        );
    }

    #[tokio::test]
    async fn test_cancel_invoice_malformed_body_returns_422() {
        let client = SorobanClient::new(
            "http://127.0.0.1:19999/soroban/rpc".to_string(),
            "CONTRACT_ID".to_string(),
            "https://horizon.stellar.org".to_string(),
        );
        let app = make_app(client);
        let server = TestServer::new(app).unwrap();

        // Malformed (non-JSON) body → 422 Unprocessable Entity
        let resp = server
            .post("/invoices/1/cancel")
            .content_type("application/json")
            .bytes(axum::body::Bytes::from_static(b"not-valid-json{{"))
            .await;
        assert_eq!(resp.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn test_cancel_invoice_unreachable_rpc_returns_error() {
        let client = SorobanClient::new(
            "http://127.0.0.1:19999/soroban/rpc".to_string(),
            "CONTRACT_ID".to_string(),
            "https://horizon.stellar.org".to_string(),
        );
        let app = make_app(client);
        let server = TestServer::new(app).unwrap();

        let resp = server
            .post("/invoices/1/cancel")
            .json(&serde_json::json!({
                "merchant": "GMERCHANT0000000000000000000000000000000000000000000000000",
                "signed_xdr": "AAAA=="
            }))
            .await;
        assert!(
            resp.status_code() == StatusCode::INTERNAL_SERVER_ERROR
                || resp.status_code() == StatusCode::NOT_FOUND
                || resp.status_code() == StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn test_cancel_invoice_unauthorized_merchant_returns_403() {
        use axum::{
            routing::post,
            Router,
        };
        use std::sync::Arc;

        let app = Router::new()
            .route("/invoices/:id/cancel", post(cancel_invoice))
            .with_state(Arc::new(SorobanClient::new(
                "http://127.0.0.1:19999/soroban/rpc".to_string(),
                "CONTRACT_ID".to_string(),
                "https://horizon.stellar.org".to_string(),
            )));

        let server = TestServer::new(app).unwrap();

        let resp = server
            .post("/invoices/1/cancel")
            .json(&serde_json::json!({
                "merchant": "GMERCHANT0000000000000000000000000000000000000000000000000",
                "signed_xdr": "AAAA=="
            }))
            .await;

        assert_eq!(resp.status_code(), StatusCode::FORBIDDEN);
        let body: serde_json::Value = resp.json();
        assert!(body.get("error").unwrap().as_str().unwrap().contains("authorised"));
    }

    #[tokio::test]
    async fn test_cancel_invoice_authorized_merchant_succeeds() {
        use axum::{
            routing::{get, post},
            Router,
        };
        use serde_json::json;
        use std::{net::SocketAddr, sync::Arc};
        use tokio::net::TcpListener;

        let mock_rpc = Router::new()
            .route(
                "/soroban/rpc",
                post(move |axum::Json(payload): axum::Json<serde_json::Value>| async move {
                    if payload
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("") == "simulateTransaction"
                    {
                        return axum::Json(json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": {
                                "map": [
                                    {"key": "id", "val": 1u64},
                                    {"key": "merchant", "val": "GMERCHANT0000000000000000000000000000000000000000000000000"},
                                    {"key": "payer", "val": "GPAYER0000000000000000000000000000000000000000000000000"},
                                    {"key": "status", "val": 0u32},
                                    {"key": "amount_usdc", "val": 100u64},
                                    {"key": "gross_usdc", "val": 100u64},
                                ]
                            }
                        }));
                    }
                    if payload
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("") == "sendTransaction"
                    {
                        return axum::Json(json!({
                            "jsonrpc": "2.0",
                            "id": 2,
                            "result": {"hash": "txhash123"}
                        }));
                    }
                    StatusCode::NOT_FOUND
                }),
            );

        let rpc_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rpc_addr = rpc_listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(rpc_listener, mock_rpc).await.unwrap();
        });

        let client = Arc::new(SorobanClient::new(
            format!("http://{rpc_addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{rpc_addr}"),
        ));

        let app = Router::new()
            .route("/invoices/:id/cancel", post(cancel_invoice))
            .with_state(client);

        let server = TestServer::new(app).unwrap();

        let resp = server
            .post("/invoices/1/cancel")
            .json(&serde_json::json!({
                "merchant": "GMERCHANT0000000000000000000000000000000000000000000000000",
                "signed_xdr": "AAAA=="
            }))
            .await;

        assert_eq!(resp.status_code(), StatusCode::OK);
        let body: serde_json::Value = resp.json();
        assert_eq!(body.get("status").unwrap().as_str().unwrap(), "cancelled");
    }
}
