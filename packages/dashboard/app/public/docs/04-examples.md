## 最小示例

下面每个示例都用 `Authorization: Bearer` 认证；把 `$DIZZY_API_KEY` 换成你在「API keys」页创建的 key。
每段示例给三种等价写法（curl / python / nodejs），请求相同、只换语言。

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

```python
import os, requests

resp = requests.post(
    "https://<站点域名>/v1/chat/completions",
    headers={"Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}"},
    json={
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": "你好"}],
    },
    timeout=120,
)
resp.raise_for_status()
print(resp.json()["choices"][0]["message"]["content"])
```

```javascript
const resp = await fetch("https://<站点域名>/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.DIZZY_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "你好" }],
  }),
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
console.log(data.choices[0].message.content);
```

### OpenAI Chat（流式）

```bash
curl -N https://<站点域名>/v1/chat/completions \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "stream": true,
       "messages": [{"role": "user", "content": "你好"}]}'
```

```python
import os, requests

with requests.post(
    "https://<站点域名>/v1/chat/completions",
    headers={"Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}"},
    json={
        "model": "deepseek-chat",
        "stream": True,
        "messages": [{"role": "user", "content": "你好"}],
    },
    stream=True,
    timeout=120,
) as resp:
    resp.raise_for_status()
    for line in resp.iter_lines(decode_unicode=True):
        if line and line.startswith("data: "):
            print(line[6:])
```

```javascript
const resp = await fetch("https://<站点域名>/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.DIZZY_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    stream: true,
    messages: [{ role: "user", content: "你好" }],
  }),
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const decoder = new TextDecoder();
for await (const chunk of resp.body) {
  process.stdout.write(decoder.decode(chunk, { stream: true }));
}
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

```python
import os, requests

resp = requests.post(
    "https://<站点域名>/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}",
        "anthropic-version": "2023-06-01",
    },
    json={
        "model": "claude-sonnet-4-5",
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "你好"}],
    },
    timeout=120,
)
resp.raise_for_status()
print(resp.json()["content"][0]["text"])
```

```javascript
const resp = await fetch("https://<站点域名>/v1/messages", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.DIZZY_API_KEY}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: "你好" }],
  }),
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
console.log(data.content[0].text);
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

```python
import os, requests

resp = requests.post(
    "https://<站点域名>/v1beta/models/gemini-2.0-flash:generateContent",
    headers={"Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}"},
    json={
        "contents": [{"role": "user", "parts": [{"text": "你好"}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 256},
    },
    timeout=120,
)
resp.raise_for_status()
print(resp.json()["candidates"][0]["content"]["parts"][0]["text"])
```

```javascript
const resp = await fetch(
  "https://<站点域名>/v1beta/models/gemini-2.0-flash:generateContent",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DIZZY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "你好" }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
    }),
  },
);
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
console.log(data.candidates[0].content.parts[0].text);
```

### Gemini 流式（必须带 alt=sse）

```bash
curl -N "https://<站点域名>/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer $DIZZY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"role": "user", "parts": [{"text": "你好"}]}]}'
```

```python
import os, requests

url = "https://<站点域名>/v1beta/models/gemini-2.0-flash:streamGenerateContent"
with requests.post(
    url,
    params={"alt": "sse"},
    headers={"Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}"},
    json={"contents": [{"role": "user", "parts": [{"text": "你好"}]}]},
    stream=True,
    timeout=120,
) as resp:
    resp.raise_for_status()
    for line in resp.iter_lines(decode_unicode=True):
        if line and line.startswith("data: "):
            print(line[6:])
```

```javascript
const url = new URL(
  "https://<站点域名>/v1beta/models/gemini-2.0-flash:streamGenerateContent",
);
url.searchParams.set("alt", "sse");
const resp = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.DIZZY_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好" }] }] }),
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const decoder = new TextDecoder();
for await (const chunk of resp.body) {
  process.stdout.write(decoder.decode(chunk, { stream: true }));
}
```

### 列出模型

```bash
curl https://<站点域名>/v1/models \
  -H "Authorization: Bearer $DIZZY_API_KEY"
```

```python
import os, requests

resp = requests.get(
    "https://<站点域名>/v1/models",
    headers={"Authorization": f"Bearer {os.environ['DIZZY_API_KEY']}"},
    timeout=30,
)
resp.raise_for_status()
for model in resp.json()["data"]:
    print(model["id"])
```

```javascript
const resp = await fetch("https://<站点域名>/v1/models", {
  headers: { Authorization: `Bearer ${process.env.DIZZY_API_KEY}` },
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
for (const model of data.data) console.log(model.id);
```
