/**
 * Ollama Response Translator
 *
 * Translates OpenAI-compatible streaming responses (from Ollama /v1/chat/completions)
 * back into Anthropic's native SSE event format that the claude-code UI expects.
 *
 * Anthropic streaming events (what the UI consumes):
 *   message_start      → { type: "message_start", message: { id, type, role, content, model, ... } }
 *   content_block_start → { type: "content_block_start", index, content_block: { type: "text"/"tool_use", ... } }
 *   content_block_delta → { type: "content_block_delta", index, delta: { type: "text_delta"/"input_json_delta", ... } }
 *   content_block_stop  → { type: "content_block_stop", index }
 *   message_delta       → { type: "message_delta", delta: { stop_reason }, usage: { ... } }
 *   message_stop        → { type: "message_stop" }
 *
 * OpenAI streaming format (what Ollama produces):
 *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"Hi"}}]}
 *   data: {"id":"...","choices":[{"delta":{"tool_calls":[{...}]}}]}
 *   data: [DONE]
 */

import { randomUUID } from 'crypto'

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenAIChunkDelta {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface OpenAIChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: OpenAIChunkDelta
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface AnthropicStreamEvent {
  type: string
  [key: string]: unknown
}

// ── State Tracker ────────────────────────────────────────────────────────────

/**
 * Tracks the state of an in-progress Anthropic message translation, since
 * OpenAI streams are stateless but Anthropic events reference content block
 * indices that must be consistent across the stream.
 */
export class ResponseStreamTranslator {
  private messageId: string
  private model: string
  private currentBlockIndex = 0
  private hasStartedMessage = false
  private hasStartedTextBlock = false
  private activeToolCalls: Map<number, {
    id: string
    name: string
    argumentBuffer: string
    blockIndex: number
    hasStarted: boolean
  }> = new Map()
  private inputTokens: number
  private outputTokens = 0

  constructor(model: string, inputTokenEstimate = 0) {
    this.messageId = `msg_ollama_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    this.model = model
    this.inputTokens = inputTokenEstimate
  }

  /**
   * Process a single OpenAI chunk and return the corresponding
   * Anthropic SSE events. May return multiple events per chunk.
   */
  translateChunk(chunk: OpenAIChunk): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // Emit message_start on the first chunk
    if (!this.hasStartedMessage) {
      this.hasStartedMessage = true
      events.push({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          container: null,
          usage: {
            input_tokens: this.inputTokens,
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

    for (const choice of chunk.choices) {
      const delta = choice.delta

      // Handle text content
      if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        // Start a text block if we haven't yet
        if (!this.hasStartedTextBlock) {
          this.hasStartedTextBlock = true
          events.push({
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: {
              type: 'text',
              text: '',
            },
          })
        }

        // Emit text delta
        events.push({
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        })

        // Rough token estimate for output
        this.outputTokens += Math.ceil(delta.content.length / 4)
      }

      // Handle tool calls
      if (delta.tool_calls) {
        // Close text block if it was open
        if (this.hasStartedTextBlock) {
          events.push({
            type: 'content_block_stop',
            index: this.currentBlockIndex,
          })
          this.currentBlockIndex++
          this.hasStartedTextBlock = false
        }

        for (const toolCall of delta.tool_calls) {
          let tracked = this.activeToolCalls.get(toolCall.index)

          // New tool call — start a tool_use content block
          if (!tracked) {
            tracked = {
              id: toolCall.id || `toolu_ollama_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
              name: toolCall.function?.name || 'unknown',
              argumentBuffer: '',
              blockIndex: this.currentBlockIndex,
              hasStarted: false,
            }
            this.activeToolCalls.set(toolCall.index, tracked)
          }

          // Update name if provided in this delta
          if (toolCall.function?.name) {
            tracked.name = toolCall.function.name
          }

          // Emit content_block_start for this tool
          if (!tracked.hasStarted) {
            tracked.hasStarted = true
            events.push({
              type: 'content_block_start',
              index: tracked.blockIndex,
              content_block: {
                type: 'tool_use',
                id: tracked.id,
                name: tracked.name,
                input: {},
              },
            })
            this.currentBlockIndex++
          }

          // Stream argument deltas
          if (toolCall.function?.arguments) {
            tracked.argumentBuffer += toolCall.function.arguments
            events.push({
              type: 'content_block_delta',
              index: tracked.blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments,
              },
            })
          }
        }
      }

      // Handle finish
      if (choice.finish_reason) {
        // Close any open text block
        if (this.hasStartedTextBlock) {
          events.push({
            type: 'content_block_stop',
            index: this.currentBlockIndex,
          })
          this.hasStartedTextBlock = false
        }

        // Close any open tool blocks
        for (const [, tracked] of this.activeToolCalls) {
          if (tracked.hasStarted) {
            events.push({
              type: 'content_block_stop',
              index: tracked.blockIndex,
            })
          }
        }

        // Map finish reason to Anthropic stop reasons
        let stopReason = 'end_turn'
        if (choice.finish_reason === 'tool_calls') {
          stopReason = 'tool_use'
        } else if (choice.finish_reason === 'length') {
          stopReason = 'max_tokens'
        } else if (choice.finish_reason === 'stop') {
          stopReason = this.activeToolCalls.size > 0 ? 'tool_use' : 'end_turn'
        }

        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
            container: null,
          },
          usage: {
            output_tokens: this.outputTokens,
            input_tokens: this.inputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        })

        events.push({ type: 'message_stop' })
      }
    }

    // Capture usage if provided
    if (chunk.usage) {
      if (chunk.usage.prompt_tokens) this.inputTokens = chunk.usage.prompt_tokens
      if (chunk.usage.completion_tokens) this.outputTokens = chunk.usage.completion_tokens
    }

    return events
  }

  /**
   * Parse a raw SSE line from Ollama's OpenAI-compat endpoint and return
   * the translated Anthropic events.
   */
  translateSSELine(line: string): AnthropicStreamEvent[] {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data: ')) {
      return []
    }

    const data = trimmed.slice(6) // Remove 'data: '
    if (data === '[DONE]') {
      // If we haven't emitted a finish, emit one now
      if (this.hasStartedMessage) {
        const events: AnthropicStreamEvent[] = []
        if (this.hasStartedTextBlock) {
          events.push({ type: 'content_block_stop', index: this.currentBlockIndex })
        }
        events.push({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null, container: null },
          usage: {
            output_tokens: this.outputTokens,
            input_tokens: this.inputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        })
        events.push({ type: 'message_stop' })
        return events
      }
      return []
    }

    try {
      const chunk: OpenAIChunk = JSON.parse(data)
      return this.translateChunk(chunk)
    } catch {
      // Malformed JSON — skip
      return []
    }
  }

  /**
   * Translate a complete non-streaming OpenAI response into an Anthropic
   * Messages API response body (for queryModelWithoutStreaming).
   */
  static translateNonStreamingResponse(
    openaiResponse: Record<string, unknown>,
    model: string,
  ): Record<string, unknown> {
    const messageId = `msg_ollama_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const choices = (openaiResponse.choices as Array<Record<string, unknown>>) || []
    const firstChoice = choices[0] || {}
    const message = (firstChoice.message as Record<string, unknown>) || {}
    const content: Array<Record<string, unknown>> = []

    // Text content
    if (message.content) {
      content.push({
        type: 'text',
        text: message.content as string,
      })
    }

    // Tool calls
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>
        let parsedInput = {}
        try {
          parsedInput = JSON.parse(fn.arguments as string)
        } catch {
          parsedInput = {}
        }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_ollama_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          name: fn.name,
          input: parsedInput,
        })
      }
    }

    // Map finish reason
    let stopReason = 'end_turn'
    if (firstChoice.finish_reason === 'tool_calls') {
      stopReason = 'tool_use'
    } else if (firstChoice.finish_reason === 'length') {
      stopReason = 'max_tokens'
    } else if (firstChoice.finish_reason === 'stop' && toolCalls && toolCalls.length > 0) {
      stopReason = 'tool_use'
    }

    const usage = openaiResponse.usage as Record<string, number> | undefined

    return {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      container: null,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
      },
    }
  }
}
