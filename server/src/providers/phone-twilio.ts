/**
 * Twilio Phone Provider
 *
 * Uses Twilio Programmable Voice API with Media Streams.
 *
 * Pricing (as of 2025):
 * - Outbound: ~$0.014/min
 * - Inbound: ~$0.0085/min
 * - Phone number: ~$1.15/month
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

interface TwilioCallResponse {
  sid: string;
  status: string;
}

export class TwilioPhoneProvider implements PhoneProvider {
  readonly name = 'twilio';
  private accountSid: string | null = null;
  private authToken: string | null = null;

  initialize(config: PhoneConfig): void {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    console.error(`Phone provider: Twilio`);
  }

  async initiateCall(to: string, from: string, webhookUrl: string): Promise<string> {
    if (!this.accountSid || !this.authToken) {
      throw new Error('Twilio not initialized');
    }

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: to,
          From: from,
          Url: webhookUrl,
          MachineDetection: 'Enable',
          MachineDetectionTimeout: '5',
        }).toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio call failed: ${response.status} ${error}`);
    }

    const data = await response.json() as TwilioCallResponse;
    return data.sid;
  }

  /**
   * Start media streaming for Twilio.
   * Note: For Twilio, streaming is started via TwiML response in the webhook,
   * not via a separate API call. This method is a no-op for Twilio.
   */
  async startStreaming(_callControlId: string, _streamUrl: string): Promise<void> {
    // Twilio starts streaming via TwiML response in getStreamConnectXml
    // This is a no-op for Twilio
  }

  /**
   * Hang up a call using Twilio REST API
   */
  async hangup(callSid: string): Promise<void> {
    if (!this.accountSid || !this.authToken) {
      throw new Error('Twilio not initialized');
    }

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          Status: 'completed',
        }).toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio hangup failed: ${response.status} ${error}`);
    }
  }

  /**
   * Get TwiML response for connecting media stream
   * This is called when Twilio requests the webhook URL after call is answered
   */
  getStreamConnectXml(streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="track" value="both_tracks"/>
    </Stream>
  </Connect>
</Response>`;
  }
}
