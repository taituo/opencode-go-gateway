# opencode-go-gateway

Authenticated OpenAI-compatible front for OpenCode Go. It is the narrow one. [ogw](https://github.com/taituo/ogw) is the open local listener.

By default this process:

- pools every current OpenCode Go key it can see, and spreads requests across the keys that offer the requested model
- publishes every model those keys expose, so two calls can ask for different models at once
- keeps a session on one key per model, and names the choice on `x-ogw-account` and `x-ogw-model`
- allows 30 requests per minute for the bearer, shared by all models
- listens on `127.0.0.1:8788`
- rejects calls that do not send `GATEWAY_BEARER`

The current key is the `opencode-go` entry in the auth file. Extra keys are read from `accounts.json` or `synth-accounts.json` in that same directory. A key that is already in the file is not added twice. `OPENCODE_ACCOUNTS_FILE` or `PI_OPENCODE_GO_STACK` replaces that discovery. `OPENCODE_GO_MODELS` narrows the model list. `REQUESTS_PER_MINUTE` changes the cap. `OGW_STATE_FILE` copies the in-memory route table to SQLite on an interval and reads it back on the next start.

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
