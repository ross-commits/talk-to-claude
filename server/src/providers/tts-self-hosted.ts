/**
 * Self-Hosted TTS Provider
 *
 * Connects to a local Kokoro TTS, MeloTTS, or Piper server running on
 * DGX Spark or any machine with a GPU.
 *
 * Expected server API (OpenAI-compatible):
 *   POST /v1/audio/speech
 *   Body: { model: "...", input: "text", voice: "...", response_format: "pcm" }
 *   Response: Raw PCM audio (24kHz 16-bit mono)
 *
 * Recommended: Kokoro TTS (82M params, ultra-low latency, great quality)
 *   pip install kokoro
 *   # Use kokoro-fastapi or similar OpenAI-compatible wrapper
 *
 * Alternative: MeloTTS
 *   pip install melotts
 *   python -m melo.server --port 8001
 *
 * Alternative: Piper (fastest, slightly lower quality)
 *   docker run -p 10200:10200 rhasspy/wyoming-piper
 */

import type { TTSProvider, TTSConfig } from './types.js';

export interface SelfHostedTTSConfig extends TTSConfig {
  /** Base URL of the TTS server (e.g., http://192.168.3.20:8001) */
  serverUrl: string;
}

export class SelfHostedTTSProvider implements TTSProvider {
  readonly name = 'self-hosted';
  private serverUrl: string = '';
  private voice: string = 'default';
  private model: string = 'default';

  initialize(config: TTSConfig): void {
    const selfHostedConfig = config as SelfHostedTTSConfig;
    if (!selfHostedConfig.serverUrl) {
      throw new Error('TTC_SELF_HOSTED_TTS_URL is required for self-hosted TTS');
    }
    this.serverUrl = selfHostedConfig.serverUrl;
    this.voice = config.voice || 'default';
    this.model = config.model || 'default';
    console.error(`TTS provider: Self-hosted (${this.serverUrl}, voice: ${this.voice})`);
  }

  /**
   * Synthesize text to PCM audio via local server
   * @returns PCM audio buffer (16-bit, mono, 24kHz)
   */
  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(`${this.serverUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'pcm',
        speed: 1.0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Self-hosted TTS failed: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Stream TTS audio as chunks arrive
   * Falls back to non-streaming if server doesn't support it
   */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    const response = await fetch(`${this.serverUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'pcm',
        speed: 1.0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Self-hosted TTS streaming failed: ${response.status} ${error}`);
    }

    const body = response.body;
    if (!body) {
      throw new Error('No response body from self-hosted TTS');
    }

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          yield Buffer.from(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
