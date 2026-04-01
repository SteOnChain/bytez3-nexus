/**
 * Ollama Provider Module
 *
 * Provides transparent Ollama integration for the claude-code CLI.
 * Supports both local Ollama instances and Ollama Cloud.
 *
 * Usage:
 *   # Local Ollama (default: http://localhost:11434)
 *   CLAUDE_CODE_USE_OLLAMA=1 ANTHROPIC_MODEL=llama3.2 claude
 *
 *   # Ollama Cloud
 *   CLAUDE_CODE_USE_OLLAMA=1 OLLAMA_BASE_URL=https://your-cloud.ollama.ai OLLAMA_API_KEY=sk-... ANTHROPIC_MODEL=llama3.2 claude
 *
 *   # Custom local port
 *   CLAUDE_CODE_USE_OLLAMA=1 OLLAMA_BASE_URL=http://localhost:11435 ANTHROPIC_MODEL=qwen2.5-coder:7b claude
 */

export { createOllamaFetchOverride, getOllamaConfig } from './ollamaClient.js'
export { translateRequest } from './requestTranslator.js'
export { ResponseStreamTranslator } from './responseTranslator.js'
