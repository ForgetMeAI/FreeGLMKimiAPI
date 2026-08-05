import path from 'path';
import { AccountManager } from './accounts.js';

export const WATERMARK = 't.me/forgetmeai';
export const PORT = Number(process.env.PORT || 9766);
export const HOST = process.env.HOST || '0.0.0.0';
export const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'kimi';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || (DEFAULT_PROVIDER === 'glm' ? 'glm-5' : 'kimi-k2.5');
export const MOCK_PROVIDER = ['1','true','yes','on'].includes(String(process.env.MOCK_PROVIDER || '').toLowerCase());
export const AUTH_PATH = process.env.AUTH_PATH || path.join(process.cwd(), 'auth.json');
export const API_KEYS = String(process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
export const GLM_BACKEND = (process.env.GLM_BACKEND || 'zai').toLowerCase();

// ── Z.ai auto-relogin via CDP ──────────────────────────────────
export const ZAI_CDP_URL = process.env.ZAI_CDP_URL || ''; // e.g. 'http://127.0.0.1:9222'
export const ZAI_TOKEN_REFRESH_ENABLED = ['1','true','yes','on'].includes(String(process.env.ZAI_TOKEN_REFRESH_ENABLED || '').toLowerCase()) || !!ZAI_CDP_URL;
export const ZAI_TOKEN_REFRESH_THRESHOLD_MS = Number(process.env.ZAI_TOKEN_REFRESH_THRESHOLD_MS || 300_000); // 5 min
export const ZAI_TOKEN_REFRESH_COOLDOWN_MS = Number(process.env.ZAI_TOKEN_REFRESH_COOLDOWN_MS || 30_000);
export const ZAI_TOKEN_REFRESH_INTERVAL_MS = Number(process.env.ZAI_TOKEN_REFRESH_INTERVAL_MS || 60_000);

export const MODELS = {
  'glm-5': { provider: 'glm', thinking: false, webSearch: false, deepResearch: false },
  'glm-5-thinking': { provider: 'glm', thinking: true, webSearch: false, deepResearch: false },
  'glm-5-search': { provider: 'glm', thinking: false, webSearch: true, deepResearch: false },
  'glm-5-deepresearch': { provider: 'glm', thinking: false, webSearch: true, deepResearch: true },
  'kimi-k2.5': { provider: 'kimi', thinking: false, webSearch: false },
  'kimi-k2.5-thinking': { provider: 'kimi', thinking: true, webSearch: false },
  'kimi-k2.5-search': { provider: 'kimi', thinking: false, webSearch: true },
};

export function resolveModel(model = DEFAULT_MODEL) {
  const id = String(model || DEFAULT_MODEL);
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
