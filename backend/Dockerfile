# Stage 1: build
FROM rust:1.75-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo fetch

COPY backend/src ./src
RUN cargo build --release --bin server

# Stage 2: runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/server /app/server

ENV SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc \
    INVOICE_CONTRACT_ID=CONTRACT_ID_PLACEHOLDER \
    HORIZON_API_URL=https://horizon.stellar.org \
    HOST=0.0.0.0 \
    PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=5s --timeout=3s --retries=10 --start-period=10s \
  CMD curl -f http://localhost:3001/health/rpc || exit 1

CMD ["/app/server"]
