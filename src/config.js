import path from 'path';
import { AccountManager } from './accounts.js';

export const WATERMARK = 't.me/forgetmeai';
export const PORT = Number(process.env.PORT || 9766);
export const HOST = process.env.HOST || '0.0.0.0';
export const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'kimi';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || (DEFAULT_PROVIDER === 'glm' ? 'glm-5' : 'kimi-k2.5');
export const MOCK_PROVIDER = ['1','true','yes','on'].includes(String(process.env.MOCK_PROVIDER || '').toLowerCase());
export const AUTH_PATH = process.env.AUTH_PATH || path.join(process.cwd(), 'data/auth.json');
export const API_KEYS = String(process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
export const GLM_BACKEND = (process.env.GLM_BACKEND || 'zai').toLowerCase();
// How long a conversation can go idle before its provider-side chat_id is
// dropped and the next turn starts a brand new chat (default 2h), and how
// many turns a single chat_id chain is allowed to grow to before the same
// reset happens (default 100). See docs/sessions.md.
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 2 * 60 * 60 * 1000);
export const SESSION_MAX_DEPTH = Number(process.env.SESSION_MAX_DEPTH || 100);
// Model lifecycle (see docs/model-lifecycle.md): where the discovered/retired
// model catalog persists across restarts (unset = in-memory only), how many
// consecutive model-not-found-shaped failures before a model is auto-retired
// from GET /v1/models, and extra regex patterns (JSON array of strings) to
// recognize a provider's "that model doesn't exist" error in addition to the
// built-in ones in src/modelCatalog.js.
export const MODEL_CATALOG_PATH = process.env.MODEL_CATALOG_PATH || '';
export const MODEL_RETIRE_AFTER_FAILURES = Number(process.env.MODEL_RETIRE_AFTER_FAILURES || 3);
export const MODEL_ERROR_PATTERNS_EXTRA = process.env.MODEL_ERROR_PATTERNS_EXTRA || '';

// Baseline catalog. This is a *seed*, not a source of truth — models get
// added automatically the first time a request against an unlisted id
// actually succeeds, and retired automatically after repeated
// model-not-found-shaped failures (see src/modelCatalog.js /
// docs/model-lifecycle.md). The glm-5.1/5.2 and kimi-k2.6/k2.7-code/k3 rows
// below reflect the real public model lineup as of Aug 2026 (GLM-5.1/5.2:
// Z.ai's own docs and chat.z.ai's page title already advertise GLM-5.1
// alongside GLM-5; Kimi K2.5 was publicly reported retired May 25 2026,
// superseded by K2.6, then the coding-focused K2.7-Code, then K3 on Jul 16
// 2026) — added so day-one /v1/models isn't stuck on a stale snapshot, but
// NOT verified against the live provider from here. The original glm-5*/
// kimi-k2.5* rows and DEFAULT_MODEL are left exactly as they were: changing
// a *default* on an unverified guess is worse than leaving a possibly-stale
// one, since a wrong guess fails differently than a stale-but-previously-
// working id. See docs/model-lifecycle.md for the full reasoning and how to
// verify/correct any of this against your own accounts.
export const MODELS = {
  'glm-5': { provider: 'glm', thinking: false, webSearch: false, deepResearch: false },
  'glm-5-thinking': { provider: 'glm', thinking: true, webSearch: false, deepResearch: false },
  'glm-5-search': { provider: 'glm', thinking: false, webSearch: true, deepResearch: false },
  'glm-5-deepresearch': { provider: 'glm', thinking: false, webSearch: true, deepResearch: true },
  'glm-5.1': { provider: 'glm', thinking: false, webSearch: false, deepResearch: false },
  'glm-5.1-thinking': { provider: 'glm', thinking: true, webSearch: false, deepResearch: false },
  'glm-5.1-search': { provider: 'glm', thinking: false, webSearch: true, deepResearch: false },
  'glm-5.2': { provider: 'glm', thinking: false, webSearch: false, deepResearch: false },
  'glm-5.2-thinking': { provider: 'glm', thinking: true, webSearch: false, deepResearch: false },
  'glm-5.2-search': { provider: 'glm', thinking: false, webSearch: true, deepResearch: false },
  'kimi-k2.5': { provider: 'kimi', thinking: false, webSearch: false },
  'kimi-k2.5-thinking': { provider: 'kimi', thinking: true, webSearch: false },
  'kimi-k2.5-search': { provider: 'kimi', thinking: false, webSearch: true },
  'kimi-k2.6': { provider: 'kimi', thinking: false, webSearch: false },
  'kimi-k2.6-thinking': { provider: 'kimi', thinking: true, webSearch: false },
  'kimi-k2.6-search': { provider: 'kimi', thinking: false, webSearch: true },
  'kimi-k2.7-code': { provider: 'kimi', thinking: false, webSearch: false },
  'kimi-k3': { provider: 'kimi', thinking: true, webSearch: false }, // K3 reportedly reasons by default ("thinking mode") rather than as a separate variant — unverified against this proxy's scenario plumbing, see docs/model-lifecycle.md
  'kimi-k3-search': { provider: 'kimi', thinking: true, webSearch: true },
};

export function resolveModel(model = DEFAULT_MODEL) {
  let id = String(model || DEFAULT_MODEL);
  // Strip known gateway prefixes (e.g., "glmkimi-free/")
  id = id.replace(/^glmkimi-free\//i, '');
  if (MODELS[id]) return { id, ...MODELS[id] };
  if (id.toLowerCase().startsWith('glm')) return { id, provider: 'glm', thinking: /think|zero|reason/i.test(id), webSearch: /search|web/i.test(id), deepResearch: /research/i.test(id) };
  if (id.toLowerCase().startsWith('kimi')) return { id, provider: 'kimi', thinking: /think|r1|reason/i.test(id), webSearch: /search|web/i.test(id) };
  return { id: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL] };
}

export function loadAccounts() {
  return new AccountManager({ authPath: AUTH_PATH, env: process.env }).rawList();
}

export function requireProxyAuth(req) {
  if (API_KEYS.length === 0) return true;
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  return API_KEYS.includes(token);
}
