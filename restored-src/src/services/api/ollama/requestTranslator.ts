/**
 * Ollama Request Translator
 *
 * Translates Anthropic Messages API request payloads into
 * OpenAI-compatible /v1/chat/completions format that Ollama supports.
 *
 * Handles:
 * - System prompt (top-level array → { role: 'system' } message)
 * - User/Assistant messages with text, images, tool_use, and tool_result blocks
 * - Tool definitions (Anthropic input_schema → OpenAI function parameters)
 * - Streaming configuration
 */

// ── Anthropic Request Types ──────────────────────────────────────────────────

export interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: {
    type: string
    media_type: string
    data: string
  }
  // Allow cache_control and other beta fields
  [key: string]: unknown
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  // Beta fields
  [key: string]: unknown
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | Array<{ type: string; text: string; [key: string]: unknown }>
  tools?: AnthropicTool[]
  tool_choice?: Record<string, unknown>
  temperature?: number
  stream?: boolean
  metadata?: Record<string, unknown>
  // Beta / extra body params
  [key: string]: unknown
}

// ── OpenAI-Compatible Request Types ──────────────────────────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIFunction {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  stream: boolean
  tools?: OpenAIFunction[]
  tool_choice?: string | Record<string, unknown>
}

// ── Main Translator ──────────────────────────────────────────────────────────

/**
 * Translate an Anthropic Messages API request body into an
 * OpenAI-compatible /v1/chat/completions request body.
 */
export function translateRequest(anthropicReq: AnthropicRequest): OpenAIRequest {
  const openaiMessages: OpenAIMessage[] = []

  // 1. System prompt → system message
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
    openaiMessages.push({ role: 'system', content: systemText })
  }

  // 2. Translate each message
  for (const msg of anthropicReq.messages) {
    const translated = translateMessage(msg)
    openaiMessages.push(...translated)
  }

  // 3. Build the OpenAI request
  const openaiReq: OpenAIRequest = {
    model: anthropicReq.model,
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens,
    temperature: anthropicReq.temperature ?? 1,
    stream: anthropicReq.stream ?? true,
  }

  // 4. Translate tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(translateTool)
    // Translate tool_choice
    if (anthropicReq.tool_choice) {
      const tc = anthropicReq.tool_choice as Record<string, unknown>
      if (tc.type === 'auto') {
        openaiReq.tool_choice = 'auto'
      } else if (tc.type === 'any') {
        openaiReq.tool_choice = 'required'
      } else if (tc.type === 'tool' && tc.name) {
        openaiReq.tool_choice = {
          type: 'function',
          function: { name: tc.name as string },
        }
      }
    }
  }

  return openaiReq
}

/**
 * Translate a single Anthropic message (user or assistant) into one or
 * more OpenAI messages. Assistant messages with tool_use blocks become
 * an assistant message with tool_calls, and user messages with
 * tool_result blocks become individual tool-role messages.
 */
function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  // Simple string content
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }]
  }

  const results: OpenAIMessage[] = []

  if (msg.role === 'assistant') {
    // Collect text blocks and tool_use blocks
    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
      // Skip thinking, redacted_thinking, connector_text, etc.
    }

    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls
    }
    results.push(assistantMsg)
  } else if (msg.role === 'user') {
    // User messages can contain text, images, and tool_result blocks
    const textParts: string[] = []
    const toolResults: OpenAIMessage[] = []

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'tool_result') {
        // Extract content from tool_result
        let resultContent = ''
        if (typeof block.content === 'string') {
          resultContent = block.content
        } else if (Array.isArray(block.content)) {
          resultContent = block.content
            .filter((b: AnthropicContentBlock) => b.type === 'text')
            .map((b: AnthropicContentBlock) => b.text || '')
            .join('\n')
        }
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: resultContent,
        })
      } else if (block.type === 'image' && block.source) {
        // Convert base64 images to text description for Ollama
        // (multimodal Ollama models handle images via the raw /api/chat endpoint;
        // via the OpenAI-compat endpoint, we pass a data URL)
        textParts.push(`[Image: ${block.source.media_type}]`)
      }
    }

    // Emit text content first, then tool results
    if (textParts.length > 0) {
      results.push({ role: 'user', content: textParts.join('\n') })
    }
    results.push(...toolResults)
  }

  return results
}

/**
 * Translate an Anthropic tool definition to OpenAI function format.
 */
function translateTool(tool: AnthropicTool): OpenAIFunction {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }
}
