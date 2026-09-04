---
name: freeglmkimi-deep-research-check
description: Check FreeGLMKimiAPI provider code for GLM deep-research (glm-5-deepresearch) support — verifies Z.ai backend passes deep_research flag and legacy chatglm backend handles it correctly
---

# FreeGLMKimiAPI GLM Deep-Research Support Check

A focused code-review sub-workflow for verifying that the `glm-5-deepresearch` model actually invokes deep research mode in both GLM backends (Z.ai and legacy chatglm).

## When to Use

- After adding/modifying model configs in `src/config.js`
- After changes to `src/providers/zai.js` or `src/providers/glm.js`
- When user reports "glm-5-deepresearch cannot run Internet search" or similar
- Periodic validation that deep research flag propagates correctly

## Procedure

### 1. Check Model Registry (`src/config.js`)

```bash
grep -A 10 "glm-5-deepresearch" src/config.js
```

**Expected:** Model defined with `deepResearch: true`, `webSearch: true`, `provider: 'glm'`

```javascript
"glm-5-deepresearch": {
  provider: "glm",
  thinking: false,
  webSearch: true,
  deepResearch: true
}
```

**Also verify:** `resolveModel()` regex detection for unknown model names:
```bash
grep -A 5 "/research/i" src/config.js
```
Should have: `/research/i` → `deepResearch: true`

### 2. Check Z.ai Backend (`src/providers/zai.js`)

```bash
grep -n "deep_research\|deepResearch\|features" src/providers/zai.js
```

**Critical check:** In `buildZaiRequest()` function, the `features` object must include `deep_research`:
```javascript
// Line ~115 in buildZaiRequest()
const features = {
  web_search: !!webSearch,
  deep_research: !!deepResearch  // ← THIS MUST BE PRESENT
};
```

**Known gap (as of ses_07ddc2e5):** Z.ai backend only sends `web_search`, missing `deep_research` field entirely.

### 3. Check Legacy chatglm Backend (`src/providers/glm.js`)

```bash
grep -n "deep_research\|chat_mode" src/providers/glm.js
```

**Expected:** Legacy backend correctly uses `chat_mode` parameter:
```javascript
chat_mode: modelCfg.deepResearch ? 'deep_research' : (modelCfg.webSearch ? 'search' : 'normal')
```

### 4. Check Provider Selection (`src/server.js`)

```bash
grep -n "providerFor\|zai\|glm" src/server.js | head -20
```

**Verify:** `providerFor()` defaults to Z.ai for GLM models. Deep research only works with legacy backend unless Z.ai is fixed.

### 5. Run Council Review (Optional)

If backend is running on port 8001 with model set `code`:
```bash
python3 council_review.py --model code --files \
  "src/config.js" \
  "src/providers/zai.js" \
  "src/providers/glm.js" \
  "src/server.js"
```

## Expected Findings

| Component | Status | Action if Missing |
|-----------|--------|-------------------|
| `config.js` model registry | ✅ Usually correct | Add `deepResearch: true` to model |
| `config.js` regex detection | ✅ Usually correct | Add `/research/i` → `deepResearch: true` |
| `zai.js` features.deep_research | ❌ **Known gap** | Add `deep_research: !!deepResearch` to features |
| `glm.js` chat_mode | ✅ Correct | No action needed |
| `server.js` provider selection | ✅ Z.ai default | Document: deep research needs legacy backend |

## Fix for Z.ai Backend

In `src/providers/zai.js`, modify `buildZaiRequest()`:

```javascript
// FIND (around line 115):
const features = {
  web_search: !!webSearch,
};

// REPLACE WITH:
const features = {
  web_search: !!webSearch,
  deep_research: !!deepResearch,  // Add this line
};
```

Also ensure `deepResearch` is extracted from `modelCfg` and passed to `buildZaiRequest()`.

## Stopping Condition

Check complete when all 4 files verified and any gaps documented with fix location.

## Related

- Global skill: `council-code-review` (for multi-model deliberation on fixes)
- Command: `local-test` (to test deep research after fix)
- Project memory: `MEMORY.md` (if created for FreeGLMKimiAPI)