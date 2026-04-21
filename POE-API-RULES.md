# POE API RULES — Tham chiếu cho ContentForge Studio V2

## Endpoint
```
POST https://api.poe.com/v1/chat/completions
Headers:
  Authorization: Bearer <API_KEY>
  Content-Type: application/json
```

## Request Body
```json
{
  "model": "BotName",
  "messages": [
    { "role": "user", "content": "prompt text" }
  ],
  "stream": true,
  "temperature": 0.7
}
```

> **QUAN TRỌNG**: Parameters (temperature, top_p, etc.) phải ở TOP-LEVEL, KHÔNG lồng trong object con.

## Bot Names (case-sensitive!)

### Text Bots
| Bot Name | Mô tả |
|----------|--------|
| Gemini-3.1-Pro | Google Gemini 3.1 Pro |
| Claude-Sonnet-4.5 | Anthropic Claude Sonnet 4.5 |
| GPT-5.2 | OpenAI GPT-5.2 |
| Gemini-3-Flash | Google Gemini 3 Flash (nhanh) |
| Gemini-2.5-Pro | Google Gemini 2.5 Pro |
| Claude-Opus-4.6 | Anthropic Claude Opus 4.6 |

### Image Bots
| Bot Name | Params |
|----------|--------|
| Nano-Banana-Pro | `aspect_ratio: "16:9"` |
| Imagen-4-Ultra | `aspect_ratio: "16:9"` |
| Imagen-4-Fast | `aspect_ratio: "16:9"` |
| Flux-2-Turbo | `aspect: "16:9"` |
| GPT-Image-1.5 | `aspect: "16:9"` |

> **Image bots**: Luôn dùng `stream: false`

## Streaming (SSE)
- Response là Server-Sent Events
- Mỗi dòng: `data: {"choices":[{"delta":{"content":"text"}}]}`
- Kết thúc: `data: [DONE]`

## Non-Streaming
```json
{
  "choices": [
    { "message": { "role": "assistant", "content": "full response" } }
  ]
}
```

## Image Response (Non-streaming)
```json
{
  "choices": [
    { "message": { "role": "assistant", "content": "![image](https://...url...)" } }
  ]
}
```

## Rate Limits
- 429: Rate limited → retry sau delay hoặc dùng fallback key
- 5xx: Server error → retry hoặc fallback key

## Rules
1. Prompt KHÔNG có prefix `@BotName` — dùng field `model` thay thế
2. Tên bot PHẢI chính xác case-sensitive
3. Image params: `aspect_ratio` cho Imagen/Nano, `aspect` cho GPT-Image/Flux
4. Image bot luôn `stream: false`, text bot nên `stream: true`
5. KHÔNG bao giờ expose API key ở frontend
