# opencode-go-gateway

Authenticated OpenAI-compatible front (`/v1/chat/completions`, `/v1/responses`,
`GET /v1/models`) for one or more OpenCode Go subscriptions. This is the code that
runs in production as the `opencode-go-gateway` service: every current Go model is
served, images are passed through, and conversations stick to one subscription
until it is rate-limited or goes idle.

What it does:

- Serves **all OpenCode Go models** the accounts expose. `OPENCODE_GO_MODELS="a,b"`
  narrows the list; startup fails if `OPENCODE_GO_MODEL` (default `gpt-5.6-luna`)
  is not among the served models.
- Passes through **images**: Chat Completions `image_url` and Responses
  `input_image` items as base64 `data:` URLs (up to 12 MB decoded). Remote image
  URLs are **not** fetched; they arrive upstream as a placeholder text note.
- Pools **multiple subscriptions** with sticky-least-loaded routing per
  conversation. Clients **must** send a conversation id, otherwise all traffic
  shares one session and one account. Accepted, in order: `x-session-id`
  (also `x-opencode-session` / `x-synth-session`), the OpenAI-style
  `prompt_cache_key` body field, and (Responses only) `metadata.session_id`.
  Stickiness expires after `OPENCODE_STICKY_IDLE_MS` (default 10 min).
  Quota/rate-limit errors put an account on cooldown and the conversation moves.
- **Telemetry**: one JSON line per routing event (no prompts, no keys) on stdout
  for journald; `GET /stats` on the stats port (same bearer) with per-model
  usage, per-account routing counters, and sticky-session count; open
  `GET /healthz`.
- **Auth**: one static bearer token, sent as `Authorization: Bearer ...` on every
  API call including `/v1/models` and `/stats`. No secrets live in this repo.

What it does **not** do:

- No request quota: the principal carries `requestsPerMinute: 30` for shape
  compatibility, but the tenant policy is ACL-only, so nothing is rate-limited.
- Not implemented: forced `tool_choice`, `response_format`, sampling parameters.
- Remote image URLs are not fetched (see above).
- `minimax-m2.7` fails (registry protocol mismatch).
- The sticky route table is in memory only; a restart re-routes conversations.
  There is no `OGW_STATE_FILE` persistence and no `OGW_FAULTS` fault injection;
  that chaos tooling lives in the `ogw` repo.

## Running

Dependencies are pinned (`package.json` + `package-lock.json`):
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `tsx`. Production
needs Node >= 22.

Accounts come from three sources, in order:

1. `PI_OPENCODE_GO_STACK="go-a:OPENCODE_GO_KEY_A,..."` (values name
   environment variables, never keys).
2. An accounts file `{"accounts":[{"name","key"}]}` — the systemd
   `synth_accounts` credential shape — or the older `[{name,env,key}]` shape
   whose keys resolve from the environment. Location: `OPENCODE_ACCOUNTS_FILE`,
   `$CREDENTIALS_DIRECTORY/synth_accounts`, or `accounts.json` /
   `synth-accounts.json` beside the auth file.
3. The `opencode-go` key in the auth file alone (`OPENCODE_AUTH_FILE`,
   `$CREDENTIALS_DIRECTORY/opencode_auth`, or the OpenCode data directory).

Keys already in the pool are not added twice. The bearer is `GATEWAY_BEARER` or
the `gateway_bearer` systemd credential (`$CREDENTIALS_DIRECTORY/gateway_bearer`).

Ports and bind address: the API listens on `GATEWAY_HOST` (default `10.91.1.1`)
port `GATEWAY_PORT` (default `8788`); the stats/health server binds the same
host on `GATEWAY_STATS_PORT` (default `8789`). Set `GATEWAY_HOST=127.0.0.1` for
single-host use. Request bodies are capped at 16 MB.

Environment reference:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_BEARER` | (required) | Static API token |
| `GATEWAY_HOST` | `10.91.1.1` | Bind address for both listeners |
| `GATEWAY_PORT` | `8788` | OpenAI-compatible API port |
| `GATEWAY_STATS_PORT` | `8789` | `/stats` + `/healthz` port |
| `OPENCODE_GO_MODELS` | all | Comma list narrowing served models |
| `OPENCODE_GO_MODEL` | `gpt-5.6-luna` | Must be served; otherwise refuse to start |
| `OPENCODE_STICKY_IDLE_MS` | `600000` | Conversation stickiness idle expiry |
| `OPENCODE_ACCOUNTS_FILE` | — | Extra subscriptions file |
| `OPENCODE_AUTH_FILE` | — | Auth file override |
| `PI_OPENCODE_GO_STACK` | — | `id:ENV_VAR,...` account wiring |
| `OGW_SESSION_ID` | `agent-runtime-lab` | Fallback routing session |
| `GATEWAY_TENANT` / `GATEWAY_SUBJECT` | `agent-runtime-lab` / `hura-koura` | Principal labels |

## systemd example (no secrets in the unit)

```ini
[Unit]
Description=OpenCode Go OpenAI-compatible gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-go-gateway
# Secret material enters ONLY as credentials; the three host paths below are
# yours to choose (shown as placeholders, never commit real paths or tokens).
LoadCredential=gateway_bearer:/srv/secrets/opencode-go-gateway/gateway-bearer
LoadCredential=opencode_auth:/srv/secrets/opencode-go-gateway/auth.json
LoadCredential=synth_accounts:/srv/secrets/opencode-go-gateway/synth-accounts.json
ExecStart=/usr/bin/node --import tsx /opt/opencode-go-gateway/src/main.ts
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`synth-accounts.json` shape: `{"accounts":[{"name":"go-a","key":"..."}]}`.

## curl examples (`<BEARER>` is a placeholder)

```bash
curl -s http://10.91.1.1:8788/v1/models \
  -H "Authorization: Bearer <BEARER>"

curl -s http://10.91.1.1:8788/v1/chat/completions \
  -H "Authorization: Bearer <BEARER>" \
  -H "x-session-id: demo-conversation-1" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"ping"}]}'

curl -s http://10.91.1.1:8789/stats \
  -H "Authorization: Bearer <BEARER>"

curl -s http://10.91.1.1:8789/healthz
```

Always send the same `x-session-id` (or `prompt_cache_key`) for one
conversation; a missing id collapses every caller onto one account.

## Tests

`npm test` runs offline unit tests (no keys, no network): account loading,
sticky session plumbing, bearer checks, session-id sources, telemetry.

## Provenance

`src/router/`, `src/backend/adapter.ts`, `src/telemetry.ts`, and the startup
flow in `src/main.ts` are the production gateway previously kept in the
`inference-gateway` repo; `src/gateway/` is the HTTP front door previously
published as the `ogw` package, vendored here so this repo builds and runs on
its own with pinned public dependencies.
