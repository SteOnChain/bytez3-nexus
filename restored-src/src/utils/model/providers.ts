import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'ollama'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OLLAMA)
    ? 'ollama'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
      ? 'bedrock'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
        ? 'vertex'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
          ? 'foundry'
          : 'firstParty'
}

/**
 * Get the Ollama base URL from environment or default to localhost.
 * Supports both local Ollama (http://localhost:11434) and Ollama Cloud (https://ollama.com).
 * Set OLLAMA_BASE_URL for custom endpoints.
 *
 * When OLLAMA_API_KEY is set without OLLAMA_BASE_URL, defaults to https://ollama.com
 * (the official Ollama Cloud endpoint per docs.ollama.com/cloud).
 */
export function getOllamaBaseUrl(): string {
  if (process.env.OLLAMA_BASE_URL) {
    return process.env.OLLAMA_BASE_URL;
  }
  if (process.env.OLLAMA_API_KEY && process.env.OLLAMA_API_KEY.trim() !== '') {
    return 'https://ollama.com';
  }
  return 'http://localhost:11434';
}

/**
 * Detect if we're using Ollama Cloud vs a local instance.
 *
 * Ollama Cloud uses the native /api/chat endpoint, while local Ollama
 * also exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * The cloud endpoint does NOT support /v1/chat/completions.
 */
export function isOllamaCloud(): boolean {
  const baseUrl = getOllamaBaseUrl();
  try {
    const host = new URL(baseUrl).host;
    return host === 'ollama.com' || host.endsWith('.ollama.com');
  } catch {
    return false;
  }
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
