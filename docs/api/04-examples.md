## 最小示例

下面每个示例都用 `Authorization: Bearer` 认证；把 `$DIZZY_API_KEY` 换成你在「API keys」页创建的 key。

### OpenAI Chat（非流式）

```bash
curl https://<站点域名>/v1/chat/completions \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### OpenAI Chat（流式）

```bash
curl -N https://<站点域名>/v1/chat/completions \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "stream": true,
       "messages": [{"role": "user", "content": "你好"}]}'
```

### Anthropic Messages

```bash
curl https://<站点域名>/v1/messages \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Gemini generateContent

```bash
curl https://<站点域名>/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "你好"}]}],
    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 256}
  }'
```

### Gemini 流式（必须带 alt=sse）

```bash
curl -N "https://<站点域名>/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"role": "user", "parts": [{"text": "你好"}]}]}'
```

### 列出模型

```bash
curl https://<站点域名>/v1/models \
  -H "Authorization: Bearer $DIZZY_API_KEY"
```
