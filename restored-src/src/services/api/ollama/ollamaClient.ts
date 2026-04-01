/**
 * Ollama Client
 *
 * Creates a fake Anthropic SDK client that transparently routes all requests
 * through Ollama's OpenAI-compatible endpoint. The rest of the claude-code
 * codebase has no idea it's talking to a local LLM.
 *
 * Supports:
 * - Local Ollama (http://localhost:11434/v1/chat/completions)
 * - Ollama Cloud (any custom OLLAMA_BASE_URL)
 * - Streaming and non-streaming responses
 * - Tool calling (function calling)
 * - Authentication via OLLAMA_API_KEY for cloud deployments
 *
 * Environment Variables:
 *   CLAUDE_CODE_USE_OLLAMA=1       → Enable Ollama provider
 *   OLLAMA_BASE_URL                → Base URL (default: http://localhost:11434)
 *   OLLAMA_API_KEY                 → API key for Ollama Cloud authentication
 *   ANTHROPIC_MODEL or --model     → Model name (e.g., llama3.2, qwen2.5-coder:7b)
 */

import { translateRequest, type AnthropicRequest } from './requestTranslator.js'
import { ResponseStreamTranslator } from './responseTranslator.js'

// ── Configuration ────────────────────────────────────────────────────────────

export function getOllamaConfig() {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
  const apiKey = process.env.OLLAMA_API_KEY || ''
  const completionsUrl = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`

  return { baseUrl, apiKey, completionsUrl }
}

// ── Fetch Override ───────────────────────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK HTTP requests
 * and redirects them to Ollama's OpenAI-compatible endpoint.
 *
 * The Anthropic SDK calls fetch() internally with the Anthropic API URL.
 * This override:
 * 1. Catches the outgoing request
 * 2. Extracts the Anthropic JSON body
 * 3. Translates it to OpenAI format
 * 4. Sends it to Ollama
 * 5. Translates the response stream back to Anthropic format
 * 6. Returns it to the SDK as if Anthropic responded
 */
export function createOllamaFetchOverride(): typeof globalThis.fetch {
  const config = getOllamaConfig()

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Only intercept POST requests to the messages endpoint
    const url = input instanceof Request ? input.url : String(input)
    const isMessagesEndpoint = url.includes('/messages')
    const method = init?.method || (input instanceof Request ? input.method : 'GET')

    if (!isMessagesEndpoint || method !== 'POST') {
      // Pass through non-messages requests (health checks, etc.)
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: AnthropicRequest
    try {
      const bodyStr = typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString('utf-8')
          : await new Response(init?.body).text()
      anthropicBody = JSON.parse(bodyStr)
    } catch (err) {
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Failed to parse request body for Ollama translation' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // Translate to OpenAI format
    const openaiBody = translateRequest(anthropicBody)
    const isStreaming = anthropicBody.stream !== false

    // Build headers for Ollama
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    try {
      // Send to Ollama
      const ollamaResponse = await globalThis.fetch(config.completionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiBody),
      })

      if (!ollamaResponse.ok) {
        const errorText = await ollamaResponse.text()
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Ollama returned ${ollamaResponse.status}: ${errorText}`,
          },
        }), {
          status: ollamaResponse.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (isStreaming) {
        return translateStreamingResponse(ollamaResponse, anthropicBody.model)
      } else {
        return translateNonStreamingResponse(ollamaResponse, anthropicBody.model)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Failed to connect to Ollama at ${config.completionsUrl}: ${errorMsg}. Is Ollama running?`,
        },
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
}

// ── Streaming Response Translation ───────────────────────────────────────────

/**
 * Takes Ollama's OpenAI-format SSE stream and translates it into
 * an Anthropic-format SSE stream that the claude-code UI expects.
 */
function translateStreamingResponse(
  ollamaResponse: Response,
  model: string,
): Response {
  const translator = new ResponseStreamTranslator(model)
  const reader = ollamaResponse.body?.getReader()

  if (!reader) {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: 'No response body from Ollama' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }

  const decoder = new TextDecoder()
  let buffer = ''

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()

        if (done) {
          // Process any remaining buffer
          if (buffer.trim()) {
            const events = translator.translateSSELine(buffer)
            for (const event of events) {
              controller.enqueue(
                new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
              )
            }
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue

          const events = translator.translateSSELine(line)
          for (const event of events) {
            controller.enqueue(
              new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
            )
          }
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      reader.cancel()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Anthropic SDK checks for these
      'x-request-id': `req_ollama_${Date.now()}`,
    },
  })
}

// ── Non-Streaming Response Translation ───────────────────────────────────────

async function translateNonStreamingResponse(
  ollamaResponse: Response,
  model: string,
): Promise<Response> {
  const openaiResult = await ollamaResponse.json() as Record<string, unknown>
  const anthropicResult = ResponseStreamTranslator.translateNonStreamingResponse(openaiResult, model)

  return new Response(JSON.stringify(anthropicResult), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': `req_ollama_${Date.now()}`,
    },
  })
}
