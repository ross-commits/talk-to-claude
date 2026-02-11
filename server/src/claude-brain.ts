/**
 * Claude Brain — Bedrock Converse API conversation manager
 *
 * Routes user speech (transcribed by Nova Sonic) through Claude Sonnet
 * on Bedrock for intelligent responses with tool access. Nova Sonic
 * handles STT/TTS; this module handles thinking.
 *
 * Uses Bedrock Converse API for native tool calling support.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeBrainConfig {
  region: string;
  model: string;
  systemPrompt: string;
  tools: ToolConfiguration;
}

export interface ClaudeResponse {
  /** Text to speak aloud (may be empty if only tool calls) */
  text: string;
  /** Tool calls to execute before speaking */
  toolUse: ToolUseBlock[];
  /** Why the model stopped: 'end_turn', 'tool_use', 'max_tokens' */
  stopReason: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ClaudeBrain {
  private client: BedrockRuntimeClient;
  private config: ClaudeBrainConfig;
  private messages: Message[] = [];

  constructor(config: ClaudeBrainConfig) {
    this.config = config;
    this.client = new BedrockRuntimeClient({ region: config.region });
  }

  /**
   * Send user's transcribed speech to Claude and get a response.
   * May return tool calls that need to be executed before speaking.
   */
  async respond(userText: string): Promise<ClaudeResponse> {
    // Add user message to history
    this.messages.push({
      role: 'user',
      content: [{ text: userText }],
    });

    return this.callConverse();
  }

  /**
   * Send tool execution results back to Claude and get the next response.
   * Called after executing tools from a previous respond() call.
   */
  async handleToolResults(
    toolUse: ToolUseBlock[],
    results: { toolUseId: string; result: string; isError?: boolean }[]
  ): Promise<ClaudeResponse> {
    // Add assistant's tool use message to history
    const assistantContent: ContentBlock[] = toolUse.map(tu => ({
      toolUse: tu,
    }));
    this.messages.push({
      role: 'assistant',
      content: assistantContent,
    });

    // Add tool results as user message
    const toolResultContent: ContentBlock[] = results.map(r => ({
      toolResult: {
        toolUseId: r.toolUseId,
        content: [{ text: r.result }],
        status: r.isError ? 'error' : 'success',
      } as ToolResultBlock,
    }));
    this.messages.push({
      role: 'user',
      content: toolResultContent,
    });

    return this.callConverse();
  }

  /**
   * Inject a message from Claude Code (continue_call) without the user speaking.
   * Framed as a system instruction so Claude naturally incorporates it.
   */
  async injectContext(message: string): Promise<ClaudeResponse> {
    this.messages.push({
      role: 'user',
      content: [{
        text: `[System: The AI assistant controlling this call wants you to tell the user the following: "${message}"]`,
      }],
    });

    return this.callConverse();
  }

  /**
   * Get the full conversation transcript (for returning to Claude Code).
   */
  getTranscript(): Array<{ role: string; text: string }> {
    const transcript: Array<{ role: string; text: string }> = [];
    for (const msg of this.messages) {
      if (!msg.content) continue;
      for (const block of msg.content) {
        if ('text' in block && block.text) {
          transcript.push({ role: msg.role || 'unknown', text: block.text });
        }
      }
    }
    return transcript;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async callConverse(): Promise<ClaudeResponse> {
    const command = new ConverseCommand({
      modelId: this.config.model,
      messages: this.messages,
      system: [{ text: this.config.systemPrompt }],
      toolConfig: this.config.tools.tools?.length ? this.config.tools : undefined,
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.7,
      },
    });

    const startTime = Date.now();
    const response = await this.client.send(command);
    const elapsed = Date.now() - startTime;
    console.error(`[Claude Brain] Converse response in ${elapsed}ms (stop: ${response.stopReason})`);

    // Parse response
    const output = response.output?.message;
    const stopReason = response.stopReason || 'end_turn';
    let text = '';
    const toolCalls: ToolUseBlock[] = [];

    if (output?.content) {
      // Add assistant response to history (for end_turn responses)
      // For tool_use responses, we add it in handleToolResults instead
      if (stopReason === 'end_turn') {
        this.messages.push({
          role: 'assistant',
          content: output.content,
        });
      }

      for (const block of output.content) {
        if ('text' in block && block.text) {
          text += block.text;
        }
        if ('toolUse' in block && block.toolUse) {
          toolCalls.push(block.toolUse);
        }
      }
    }

    return { text, toolUse: toolCalls, stopReason };
  }
}
