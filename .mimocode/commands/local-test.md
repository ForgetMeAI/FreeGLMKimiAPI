---
description: Start FreeGLMKimiAPI server locally and test with a curl request to /v1/chat/completions
agent: main
---

# Local Test Command

Start the FreeGLMKimiAPI server locally (with optional mock provider) and run a test request against the OpenAI-compatible endpoint.

## Usage

```bash
/mimocode:command local-test [model] [port] [--mock] [--bg]
```

## Parameters

- `model` (optional): Model to test. Default: `glm-5-search`
- `port` (optional): Server port. Default: `9766` (from config.js)
- `--mock`: Set `MOCK_PROVIDER=1` to test without real API credentials
- `--bg`: Run server in background and leave it running after test

## Procedure

1. **Stop any existing server on the port**
   ```bash
   pkill -f "node src/server.js" 2>/dev/null || true
   sleep 1
   ```

2. **Start the server**
   ```bash
   cd /home/yury/Documents/FreeGLMKimiAPI
   
   # Environment setup
   export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
   export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
   export CHROME_PATH=/usr/bin/chromium
   export ZAI_BROWSER_ENGINE=cloak
   
   if [ "${MOCK:-false}" = "true" ]; then
     export MOCK_PROVIDER=1
   fi
   
   PORT=${PORT:-9766} node src/server.js &
   SERVER_PID=$!
   sleep 3
   ```

3. **Verify server is running**
   ```bash
   ps aux | grep "server.js" | grep -v grep
   ```

4. **Run test request**
   ```bash
   curl -X POST http://localhost:${PORT:-9766}/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "${MODEL:-glm-5-search}",
       "messages": [{"role": "user", "content": "hello"}],
       "stream": false
     }'
   ```

5. **Stop server** (unless `--bg` specified)
   ```bash
   if [ "${BG:-false}" != "true" ]; then
     kill $SERVER_PID 2>/dev/null || true
   fi
   ```

## Example Invocations

```bash
# Default test (glm-5-search on port 9766)
/mimocode:command local-test

# Test kimi-k2.5 model
/mimocode:command local-test kimi-k2.5

# Test with mock provider (no real API keys needed)
/mimocode:command local-test glm-5-search --mock

# Start server in background and leave running
/mimocode:command local-test --bg

# Test specific port
/mimocode:command local-test glm-5-search 9767
```

## Notes

- Server runs on port 9766 by default (configured in `src/config.js`)
- Real credentials loaded from `/home/yury/Documents/FreeGLMKimiAPI/data/auth.json`
- `ZAI_BROWSER_ENGINE=cloak` required for GLM browser fallback to work
- System chromium at `/usr/bin/chromium` must be installed (Node 22+)
- First GLM browser request takes ~100s (chromium download + warmup); subsequent requests faster
- Kimi provider works end-to-end with real credentials (~2s response)