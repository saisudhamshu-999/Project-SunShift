# SunShift as one service: FastAPI serves the API under /api and the built site everywhere else.

# 1. Build the frontend (it imports shared/scenario.json at build time).
FROM node:22-slim AS web
WORKDIR /src
COPY shared ./shared
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
RUN npm --prefix frontend run build

# 2. Python runtime with OR-Tools, pvlib and the built site.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt
COPY shared ./shared
COPY backend/app ./backend/app
COPY --from=web /src/frontend/dist ./frontend/dist

RUN useradd --create-home --uid 10001 sunshift \
    && mkdir -p backend/data \
    && chown sunshift backend/data
USER sunshift

ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8000\")}/api/health', timeout=4)"
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
