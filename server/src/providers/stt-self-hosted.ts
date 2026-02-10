/**
 * Self-Hosted STT Provider
 *
 * Connects to a local faster-whisper or whisper.cpp server running on
 * DGX Spark or any machine with a GPU.
 *
 * Expected server API (OpenAI-compatible):
 *   POST /v1/audio/transcriptions
 *   WebSocket /v1/audio/transcriptions/stream (for streaming)
 *
 * Recommended server: faster-whisper-server
 *   https://github.com/fedirz/faster-whisper-server
 *
 * Deploy on DGX Spark:
 *   docker run -d --gpus all -p 8000:8000 \
 *     fedirz/faster-whisper-server:latest \
 *     --model large-v3 --device cuda --compute_type int8
 *
 * Or run directly:
 *   pip install faster-whisper
 *   python -m faster_whisper.server --model large-v3 --port 8000
 */

import WebSocket from 'ws';
import type { RealtimeSTTProvider, RealtimeSTTSession, STTConfig } from './types.js';

export interface SelfHostedSTTConfig extends STTConfig {
  /** Base URL of the STT server (e.g., http://192.168.3.20:8000) */
  serverUrl: string;
}

export class SelfHostedSTTProvider implements RealtimeSTTProvider {
  readonly name = 'self-hosted';
  private serverUrl: string = '';
  private silenceDurationMs: number = 800;

  initialize(config: STTConfig): void {
    const selfHostedConfig = config as SelfHostedSTTConfig;
    if (!selfHostedConfig.serverUrl) {
      throw new Error('TTC_SELF_HOSTED_STT_URL is required for self-hosted STT');
    }
    this.serverUrl = selfHostedConfig.serverUrl;
    this.silenceDurationMs = config.silenceDurationMs || 800;
    console.error(`STT provider: Self-hosted (${this.serverUrl})`);
  }

  createSession(): RealtimeSTTSession {
    // TODO: Implement WebSocket streaming to faster-whisper-server
    // The session will:
    // 1. Open WebSocket to serverUrl/v1/audio/transcriptions/stream
    // 2. Send mu-law audio chunks (converted to PCM if needed)
    // 3. Receive streaming transcription results
    // 4. Handle VAD events for turn detection
    throw new Error('Self-hosted STT session not yet implemented');
  }
}
