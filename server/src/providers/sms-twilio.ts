/**
 * Twilio SMS/MMS Provider
 *
 * Send and receive text messages using the same Twilio number
 * that handles voice calls. No additional setup needed.
 *
 * Pricing (US numbers):
 * - Outbound SMS: $0.0079/segment (160 chars)
 * - Outbound MMS: $0.0200/message
 * - Inbound SMS:  $0.0075/segment
 * - Inbound MMS:  $0.0100/message
 */

export interface SMSConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export interface IncomingSMS {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
  timestamp: number;
}

export class TwilioSMSProvider {
  readonly name = 'twilio-sms';
  private accountSid: string | null = null;
  private authToken: string | null = null;
  private phoneNumber: string | null = null;

  initialize(config: SMSConfig): void {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.phoneNumber = config.phoneNumber;
    console.error(`SMS provider: Twilio (${config.phoneNumber})`);
  }

  /**
   * Send an SMS or MMS message
   * @param to Destination phone number (E.164 format)
   * @param body Message text
   * @param mediaUrls Optional: publicly accessible URLs for MMS attachments
   * @returns Message SID for tracking
   */
  async sendSMS(to: string, body: string, mediaUrls?: string[]): Promise<string> {
    if (!this.accountSid || !this.authToken || !this.phoneNumber) {
      throw new Error('Twilio SMS not initialized');
    }

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const params: Record<string, string> = {
      To: to,
      From: this.phoneNumber,
      Body: body,
    };

    // Add media URLs for MMS (up to 10)
    if (mediaUrls && mediaUrls.length > 0) {
      mediaUrls.slice(0, 10).forEach((url, i) => {
        params[`MediaUrl${i > 0 ? String(i) : ''}`] = url;
      });
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio SMS failed: ${response.status} ${error}`);
    }

    const data = await response.json() as { sid: string };
    console.error(`SMS sent to ${to}: ${body.substring(0, 50)}... (SID: ${data.sid})`);
    return data.sid;
  }

  /**
   * Parse an incoming SMS webhook from Twilio
   * @param params URL-encoded form parameters from webhook
   */
  static parseIncomingWebhook(params: URLSearchParams): IncomingSMS {
    const numMedia = parseInt(params.get('NumMedia') || '0', 10);
    const mediaUrls: string[] = [];
    const mediaContentTypes: string[] = [];

    for (let i = 0; i < numMedia; i++) {
      const url = params.get(`MediaUrl${i}`);
      const type = params.get(`MediaContentType${i}`);
      if (url) mediaUrls.push(url);
      if (type) mediaContentTypes.push(type);
    }

    return {
      messageSid: params.get('MessageSid') || '',
      from: params.get('From') || '',
      to: params.get('To') || '',
      body: params.get('Body') || '',
      mediaUrls,
      mediaContentTypes,
      timestamp: Date.now(),
    };
  }

  /**
   * Generate TwiML response for incoming SMS
   * @param reply Text to send back (or empty for no reply)
   */
  static generateReplyTwiML(reply?: string): string {
    if (!reply) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    // Escape XML special characters
    const escaped = reply
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escaped}</Message>
</Response>`;
  }
}
