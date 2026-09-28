# DeepKrak3n standalone Railway service

This repository contains two separate runtime surfaces:

- The DeepKrak3n web workspace under `artifacts/deepkrak3n/`.
- This standalone FastAPI service, deployed independently on Railway.

The Railway service performs public username discovery only. It does not use
the AdRoom backend, AdRoom database, AdRoom secrets, authenticated sessions,
cookies, private accounts, or the Replit development URL.

## Local setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
PORT=8000 gunicorn -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:$PORT
```

The service listens on `0.0.0.0` and uses the `PORT` environment variable.

## Railway deployment

Create a separate Railway service from this repository. Railway detects the
Python project from `requirements.txt` and starts the single `web` process in
`Procfile`:

```text
web: gunicorn -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:$PORT
```

Configure the Railway health check path as `/health`. Railway supplies `PORT`
automatically. Set `CORS_ORIGINS` to the public frontend origin if browser
requests will call this service directly.

After Railway assigns a public HTTPS domain, configure AdRoom with:

```text
DEEPKRAK3N_BASE_URL=https://<actual-deepkrak3n-railway-domain>
```

Do not use the AdRoom Railway URL for this service.

## Endpoints

### Health

```bash
curl -i https://<deepkrak3n-railway-domain>/health
```

Expected response:

```json
{"status":"ok","service":"deepkrak3n"}
```

### Username search

The request accepts a public username in the query string. It defaults to 30
checks and caps the limit at 30. The body may be empty.

```bash
curl -i -X POST \
  "https://<deepkrak3n-railway-domain>/api/search/username?username=public-user&limit=30" \
  -H "Accept: application/json"
```

The JSON response includes `found_profiles` and `all_results`. Each result
contains a public profile URL, site, status, and non-sensitive diagnostic
fields.

### Streaming username search

```bash
curl -N \
  "https://<deepkrak3n-railway-domain>/api/search/username/stream?username=public-user&limit=30" \
  -H "Accept: text/event-stream"
```

### Other local-analysis endpoints

- `GET /api/network/status` — reports proxy state without exposing credentials.
- `POST /api/proxy/toggle?enabled=true|false` — keeps proxy mode disabled unless configured.
- `POST /api/profile/analyze` — returns heuristic analysis for supplied public profile metadata.
- `POST /api/prompt` — updates the local analysis prompt file.
- `GET /api/ollama/models?host=http://localhost:11434` — checks an optional local Ollama host.

## Error behavior

- `400` — missing, invalid, or unsafe username/limit.
- `429` — reserved for rate limiting at the hosting layer.
- `500` — unexpected internal failure.
- `503` — unavailable search dependency where applicable.

Clients receive sanitized errors; stack traces, filesystem paths, credentials,
cookies, and environment values are never returned.

## Privacy limitations

This service is intentionally limited to public profile discovery. It does not
log in, handle passwords or session cookies, access private accounts, collect
private messages, enumerate private contact data, use credential stuffing, or
persist unnecessary profile data. Upstream sites may block or rate-limit
requests, so a result is an availability signal rather than proof of identity.