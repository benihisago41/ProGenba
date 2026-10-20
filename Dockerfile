# ============================================================================
# Stage 1: Frontend Builder
# ============================================================================
FROM node:22-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ============================================================================
# Stage 2: Backend Builder
# ============================================================================
FROM rust:1.80-bookworm AS backend-builder

WORKDIR /build/backend

COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/ ./
RUN cargo build --release --locked

# ============================================================================
# Stage 3: Runtime
# ============================================================================
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 appuser \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY --from=backend-builder --chown=10001:10001 /build/backend/target/release/sirius-reborn-backend /app/sirius-reborn-backend
COPY --from=frontend-builder --chown=10001:10001 /build/frontend/dist /app/static

ENV STATIC_DIR=/app/static

USER 10001:10001

EXPOSE 8080

ENTRYPOINT ["/app/sirius-reborn-backend"]
