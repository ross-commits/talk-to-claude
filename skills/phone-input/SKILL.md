# Voice & Text Input Skill

## Description
Call or text the user for real-time communication. Use voice for complex discussions and text for quick updates or when a call isn't appropriate.

## When to Use This Skill

**Use voice (call) when:**
- You've **completed a significant task** and want to discuss next steps
- You need **real-time back-and-forth** for complex decisions
- You're **blocked** and need urgent clarification
- The discussion benefits from **tone and nuance**

**Use text (SMS) when:**
- Sending a **quick status update** that doesn't need a response
- The user is likely **in a meeting** or can't take a call
- Sharing a **link, code snippet, or short result**
- Following up after a call with a **summary**

**Do NOT use for:**
- Simple yes/no questions (use text instead of calling)
- Information the user has already provided
- Routine updates that don't need acknowledgment

## Tools

### Voice Tools

#### `initiate_call`
Start a phone call with the user.

**Parameters:**
- `message` (string): What you want to say. Be natural and conversational.

**Returns:**
- Call ID and the user's spoken response (transcribed to text)

#### `continue_call`
Continue an active call with a follow-up message.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): Your follow-up message

**Returns:**
- The user's response

#### `speak_to_user`
Speak a message on an active call without waiting for a response. Use this to acknowledge requests before time-consuming operations.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): What to say to the user

**Returns:**
- Confirmation that the message was spoken

#### `end_call`
End an active call with a closing message.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): Your closing message (say goodbye!)

**Returns:**
- Call duration in seconds

### Text Tools (Coming Soon)

#### `send_text`
Send an SMS or MMS message to the user.

**Parameters:**
- `message` (string): The text message to send
- `media_urls` (string[], optional): URLs of images/files to attach (MMS)

**Returns:**
- Message SID for tracking

#### `check_texts`
Check for incoming text messages from the user.

**Returns:**
- Array of recent messages with timestamps

## Example Usage

**Voice -- simple conversation:**
```
1. initiate_call: "Hey! I finished the auth system. Should I move on to the API endpoints?"
2. User responds: "Yes, go ahead"
3. end_call: "Perfect! I'll start on the API endpoints. Talk soon!"
```

**Voice -- multi-turn with acknowledgment:**
```
1. initiate_call: "Hey! I finished the database migration. What should I work on next?"
2. User: "Can you look up the latest API documentation for Stripe?"
3. speak_to_user: "Sure! Let me search for that. Give me a moment..."
4. [Perform web search]
5. continue_call: "Found the latest Stripe docs. They released v2024.1 with new payment methods..."
6. User: "Great, implement that"
7. end_call: "On it! I'll implement the new payment methods. Talk soon!"
```

**Text -- quick update:**
```
1. send_text: "Auth system deployed successfully. 47 tests passing. Moving to API endpoints next."
```

**Choosing the right channel:**
```
- Need a decision between 3 approaches? -> Call
- Finished a task, user said "text me when done"? -> Text
- Blocked on credentials? -> Call
- Sharing a URL or error message? -> Text
```

## Best Practices

1. **Be conversational on calls** -- talk naturally, not like a robot
2. **Use speak_to_user for acknowledgments** -- don't leave silence during long operations
3. **Text for async, call for sync** -- match the urgency to the channel
4. **Always end calls gracefully** -- say goodbye and state what you'll do next
5. **Keep texts concise** -- SMS has 160-char segments, respect that
