---
description: Build, start, and test the FreeGLMKimiAPI Docker container with a curl request to /v1/chat/completions
agent: main
---

# Docker Test Command

Build the Docker image, start the container, and run a test request against the OpenAI-compatible endpoint.

## Usage

```bash
/mimocode:command docker-test [model] [port] [--no-cache] [--mock]
```

## Parameters

- `model` (optional): Model to test. Default: `glm-5-search`
- `port` (optional): Host port mapped to container port 3364. Default: `3364`
- `--no-cache`: Run `docker-compose build --no-cache`
- `--mock`: Set `MOCK_PROVIDER=1` in container environment (tests without real credentials)

## Procedure

1. **Build the image**
   ```bash
   cd /home/yury/Documents/FreeGLMKimiAPI
   docker-compose build [--no-cache]
   ```

2. **Start the container** (detached)
   ```bash
   docker-compose up -d
   ```

3. **Wait for server readiness** (5-10 seconds)
   ```bash
   sleep 8
   ```

4. **Run test request**
   ```bash
   curl -X POST http://localhost:${PORT:-3364}/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "${MODEL:-glm-5-search}",
       "messages": [{"role": "user", "content": "hello"}],
       "stream": false
     }'
   ```

5. **Show container logs** (last 30 lines)
   ```bash
   docker-compose logs --tail=30
   ```

6. **Stop container** (optional, for clean state)
   ```bash
   docker-compose down
   ```

## Example Invocations

```bash
# Default test (glm-5-search on port 3364)
/mimocode:command docker-test

# Test kimi-k2.5 model
/mimocode:command docker-test kimi-k2.5

# Test with mock provider (no real API keys needed)
/mimocode:command docker-test glm-5-search --mock

# Full rebuild without cache
/mimocode:command docker-test --no-cache
```

## Notes

- The container exposes port 3364 internally; docker-compose.yml maps it to host port 3364 by default
- VNC is available at `vnc://localhost:3365` (password: `vampir`) when `ENABLE_VNC=1`
- Real credentials are loaded from `/home/yury/Documents/FreeGLMKimiAPI/data/auth.json` (mounted in container)
- `ZAI_BROWSER_ENGINE=cloak` is set in Dockerfile ENV for GLM browser fallback
- Node 22 and system chromium are pre-installed in the image