# opencode-go-gateway

Authenticated OpenAI-compatible front for OpenCode Go. It is the narrow one. [ogw](https://github.com/taituo/ogw) is the open local listener.

By default this process:

- uses the single `opencode-go` key from OpenCode's current auth file
- publishes one model, `gpt-5.6-luna`
- allows 30 requests per minute for that bearer
- listens on `127.0.0.1:8788`
- rejects calls that do not send `GATEWAY_BEARER`

It does not read a multikey file unless you set one. `PI_OPENCODE_GO_STACK` or `OPENCODE_ACCOUNTS_FILE` opts into several keys. `OPENCODE_GO_MODELS` widens the model list. `REQUESTS_PER_MINUTE` changes the cap.

OpenCode's current auth is found in this order:

1. `OPENCODE_AUTH_FILE`
2. `$CREDENTIALS_DIRECTORY/opencode_auth` (the systemd credential)
3. `$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json`

The bearer is `GATEWAY_BEARER` or `$CREDENTIALS_DIRECTORY/gateway_bearer`.

```bash
GATEWAY_BEARER=... npm start
OPENCODE_ACCOUNTS_FILE=/path/to/accounts.json GATEWAY_BEARER=... npm start
```

No install path or home directory is built into the program. Set `GATEWAY_HOST` when it should listen beyond localhost.
