/**
 * Ollama Client
 *
 * Creates a fake Anthropic SDK client that transparently routes all requests
 * through Ollama. Supports TWO modes:
 *
 * 1. LOCAL OLLAMA (http://localhost:11434)
 *    → Uses /v1/chat/completions (OpenAI-compatible endpoint)
 *    → Request/response is in OpenAI format
 *    → Streaming uses SSE (data: {json}\n\n)
 *
 * 2. OLLAMA CLOUD (https://ollama.com)
 *    → Uses /api/chat (native Ollama endpoint)
 *    → Request/response is in native Ollama format
 *    → Streaming uses NDJSON (one JSON object per line)
 *    → Authentication via Bearer token
 *
 * The rest of the claude-code codebase has no idea it's talking to a local/cloud LLM.
 *
 * Environment Variables:
 *   CLAUDE_CODE_USE_OLLAMA=1       → Enable Ollama provider
 *   OLLAMA_BASE_URL                → Base URL (auto-detected if not set)
 *   OLLAMA_API_KEY                 → API key for Ollama Cloud authentication
 *   ANTHROPIC_MODEL or --model     → Model name (e.g., qwen3-coder:480b)
 */

import { translateRequest, type AnthropicRequest } from './requestTranslator.js'
import { ResponseStreamTranslator } from './responseTranslator.js'
import { randomUUID } from 'crypto'

// ── Configuration ────────────────────────────────────────────────────────────

import { getOllamaBaseUrl, isOllamaCloud } from '../../../utils/model/providers.js'

export function getOllamaConfig() {
  const baseUrl = getOllamaBaseUrl()
  const apiKey = process.env.OLLAMA_API_KEY || ''
  const cloud = isOllamaCloud()

  // Cloud uses native /api/chat, local uses OpenAI-compat /v1/chat/completions
  const completionsUrl = cloud
    ? `${baseUrl.replace(/\/$/, '')}/api/chat`
    : `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`

  return { baseUrl, apiKey, completionsUrl, cloud }
}

// ── Native Ollama Request Translation ────────────────────────────────────────

/**
 * Translate an Anthropic request directly to native Ollama /api/chat format.
 * This is used for Ollama Cloud which doesn't support /v1/chat/completions.
 */
interface OllamaNativeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> }
  }>
}

interface OllamaNativeRequest {
  model: string
  messages: OllamaNativeMessage[]
  stream: boolean
  options?: {
    temperature?: number
    num_predict?: number
  }
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

function translateToNativeOllamaRequest(anthropicReq: AnthropicRequest): OllamaNativeRequest {
  const messages: OllamaNativeMessage[] = []

  // System prompt
  if (anthropicReq.system) {
    let systemText: string
    if (typeof anthropicReq.system === 'string') {
      systemText = anthropicReq.system
    } else if (Array.isArray(anthropicReq.system)) {
      systemText = anthropicReq.system
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
    } else {
      systemText = String(anthropicReq.system)
    }
    messages.push({ role: 'system', content: systemText })
  }

  // Messages
  for (const msg of anthropicReq.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: OllamaNativeMessage['tool_calls'] = []

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) textParts.push(block.text)
        if (block.type === 'tool_use' && block.name) {
          toolCalls.push({
            function: {
              name: block.name,
              arguments: block.input || {},
            },
          })
        }
      }

      const assistantMsg: OllamaNativeMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      messages.push(assistantMsg)
    } else {
      // User messages
      const textParts: string[] = []

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'tool_result') {
          let resultContent = ''
          if (typeof block.content === 'string') resultContent = block.content
          else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text || '')
              .join('\n')
          }
          messages.push({
            role: 'tool',
            content: resultContent,
          })
        }
      }

      if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.join('\n') })
      }
    }
  }

  const nativeReq: OllamaNativeRequest = {
    model: anthropicReq.model,
    messages,
    stream: anthropicReq.stream ?? true,
    options: {
      temperature: anthropicReq.temperature ?? 1,
      num_predict: anthropicReq.max_tokens,
    },
  }

  // Translate tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    nativeReq.tools = anthropicReq.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
  }

  return nativeReq
}

// ── Fetch Override ───────────────────────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK HTTP requests
 * and redirects them to Ollama (local or cloud).
 */
export function createOllamaFetchOverride(): typeof globalThis.fetch {
  const config = getOllamaConfig()
  console.error(`[Ollama] Config: cloud=${config.cloud}, url=${config.completionsUrl}, hasKey=${!!config.apiKey}`)

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

    const isStreaming = anthropicBody.stream !== false

    // Build the request body based on mode
    let requestBody: string
    if (config.cloud) {
      // Ollama Cloud: use native /api/chat format
      const nativeReq = translateToNativeOllamaRequest(anthropicBody)
      requestBody = JSON.stringify(nativeReq)
    } else {
      // Local Ollama: use OpenAI-compatible format
      const openaiBody = translateRequest(anthropicBody)
      requestBody = JSON.stringify(openaiBody)
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    try {
      // Send to Ollama — use a generous timeout to prevent UND_ERR_BODY_TIMEOUT
      // on slow cloud models. Default undici body timeout (~300s) is too short
      // for large models that may take minutes between first and last token.
      const fetchController = new AbortController()
      const OLLAMA_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
      const timeoutId = setTimeout(() => fetchController.abort(), OLLAMA_TIMEOUT_MS)

      const ollamaResponse = await globalThis.fetch(config.completionsUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: fetchController.signal,
        // @ts-ignore — undici-specific: disable the body inactivity timeout
        // that causes UND_ERR_BODY_TIMEOUT when the model is slow.
        keepalive: true,
      })
      clearTimeout(timeoutId)


      if (!ollamaResponse.ok) {
        const errorText = await ollamaResponse.text()
        console.error(`[Ollama] Error response (${ollamaResponse.status}): ${errorText.substring(0, 300)}`)
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

      if (config.cloud) {
        // Cloud responses use native Ollama format
        if (isStreaming) {
          return translateCloudStreamingResponse(ollamaResponse, anthropicBody.model)
        } else {
          return translateCloudNonStreamingResponse(ollamaResponse, anthropicBody.model)
        }
      } else {
        // Local responses use OpenAI format
        if (isStreaming) {
          return translateLocalStreamingResponse(ollamaResponse, anthropicBody.model)
        } else {
          return translateLocalNonStreamingResponse(ollamaResponse, anthropicBody.model)
        }
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

// ── Cloud Response Translation (Native Ollama NDJSON) ────────────────────────

/**
 * Ollama Cloud /api/chat streaming returns NDJSON (one JSON object per line):
 *   {"model":"...","message":{"role":"assistant","content":"Hi"},"done":false}
 *   {"model":"...","message":{"role":"assistant","content":"!"},"done":false}
 *   {"model":"...","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",...}
 *
 * We translate this into Anthropic SSE events.
 */
function translateCloudStreamingResponse(
  ollamaResponse: Response,
  model: string,
): Response {
  const reader = ollamaResponse.body?.getReader()

  if (!reader) {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: 'No response body from Ollama Cloud' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }

  const decoder = new TextDecoder()
  const messageId = `msg_ollama_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  let buffer = ''
  let hasStartedMessage = false
  let hasStartedTextBlock = false
  let blockIndex = 0
  let outputTokens = 0
  let hasFinalized = false

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()

        if (done) {
          // Finalize — only if processLine didn't already finalize
          if (buffer.trim()) {
            processLine(buffer.trim())
          }
          if (!hasFinalized) {
            if (hasStartedTextBlock) {
              enqueue({ type: 'content_block_stop', index: blockIndex })
            }
            if (hasStartedMessage) {
              enqueue({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null, container: null },
                usage: {
                  output_tokens: outputTokens,
                  input_tokens: 0,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                  server_tool_use: null,
                },
              })
              enqueue({ type: 'message_stop' })
            }
            hasFinalized = true
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          processLine(line.trim())
        }
      } catch (err) {
        console.error(`[Ollama Stream] Error:`, err)
        controller.error(err)
      }

      function enqueue(event: Record<string, unknown>) {
        controller.enqueue(
          new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }

      function processLine(line: string) {
        let chunk: any
        try {
          chunk = JSON.parse(line)
        } catch {
          return
        }

        // Emit message_start on first chunk
        if (!hasStartedMessage) {
          hasStartedMessage = true
          enqueue({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model,
              stop_reason: null,
              stop_sequence: null,
              container: null,
              usage: {
                input_tokens: chunk.prompt_eval_count || 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: null,
                service_tier: null,
                cache_creation: null,
                inference_geo: null,
              },
            },
          })
        }

        const msg = chunk.message
        if (msg && msg.content) {
          // Start text block if needed
          if (!hasStartedTextBlock) {
            hasStartedTextBlock = true
            enqueue({
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            })
          }

          // Text delta
          enqueue({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: msg.content },
          })
          outputTokens += Math.ceil(msg.content.length / 4)
        }

        // Handle tool calls from cloud
        if (msg && msg.tool_calls && msg.tool_calls.length > 0) {
          // Close text block if open
          if (hasStartedTextBlock) {
            enqueue({ type: 'content_block_stop', index: blockIndex })
            blockIndex++
            hasStartedTextBlock = false
          }

          for (const tc of msg.tool_calls) {
            const fn = tc.function
            const toolId = `toolu_ollama_${randomUUID().replace(/-/g, '').slice(0, 16)}`
            enqueue({
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: toolId,
                name: fn.name,
                input: {},
              },
            })
            // Emit the full arguments as a single delta
            const argsStr = JSON.stringify(fn.arguments || {})
            enqueue({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: argsStr },
            })
            enqueue({ type: 'content_block_stop', index: blockIndex })
            blockIndex++
          }
        }

        // Handle completion
        if (chunk.done === true) {
          if (hasStartedTextBlock) {
            enqueue({ type: 'content_block_stop', index: blockIndex })
            hasStartedTextBlock = false
          }

          // Determine stop reason
          let stopReason = 'end_turn'
          if (chunk.done_reason === 'stop') {
            stopReason = (msg?.tool_calls?.length > 0) ? 'tool_use' : 'end_turn'
          } else if (chunk.done_reason === 'length') {
            stopReason = 'max_tokens'
          }

          outputTokens = chunk.eval_count || outputTokens

          enqueue({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null, container: null },
            usage: {
              output_tokens: outputTokens,
              input_tokens: chunk.prompt_eval_count || 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
            },
          })
          enqueue({ type: 'message_stop' })
          hasFinalized = true
        }
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
      'x-request-id': `req_ollama_${Date.now()}`,
    },
  })
}

/**
 * Translate a non-streaming Ollama Cloud /api/chat response:
 *   {"model":"...","message":{"role":"assistant","content":"Hello!"},"done":true,...}
 */
async function translateCloudNonStreamingResponse(
  ollamaResponse: Response,
  model: string,
): Promise<Response> {
  const nativeResult = await ollamaResponse.json() as Record<string, unknown>
  const messageId = `msg_ollama_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const msg = nativeResult.message as Record<string, unknown> | undefined
  const content: Array<Record<string, unknown>> = []

  // Text content
  if (msg?.content) {
    content.push({ type: 'text', text: msg.content as string })
  }

  // Tool calls
  if (msg?.tool_calls) {
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>>
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown>
      content.push({
        type: 'tool_use',
        id: `toolu_ollama_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        name: fn.name,
        input: fn.arguments || {},
      })
    }
  }

  let stopReason = 'end_turn'
  const doneReason = nativeResult.done_reason as string | undefined
  if (doneReason === 'length') {
    stopReason = 'max_tokens'
  } else if ((msg?.tool_calls as unknown[])?.length > 0) {
    stopReason = 'tool_use'
  }

  const anthropicResult = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: (nativeResult.prompt_eval_count as number) || 0,
      output_tokens: (nativeResult.eval_count as number) || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
      inference_geo: null,
    },
  }

  return new Response(JSON.stringify(anthropicResult), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': `req_ollama_${Date.now()}`,
    },
  })
}

// ── Local Response Translation (OpenAI SSE) ──────────────────────────────────

/**
 * Takes local Ollama's OpenAI-format SSE stream and translates it into
 * an Anthropic-format SSE stream that the claude-code UI expects.
 */
function translateLocalStreamingResponse(
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
      'x-request-id': `req_ollama_${Date.now()}`,
    },
  })
}

/**
 * Translate a non-streaming OpenAI-format response from local Ollama.
 */
async function translateLocalNonStreamingResponse(
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
