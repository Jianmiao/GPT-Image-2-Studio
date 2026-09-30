# 中转站适配说明（内部实现备忘）

本文件记录"自动获取模型"与"多协议生图"的判定规则，便于以后接新的中转站时快速定位。

## 1. 地址归一化 `relay.normalizeBaseUrl()`

```
输入                                  → 归一化结果
https://api.xxx.com                   → https://api.xxx.com
https://api.xxx.com/                  → https://api.xxx.com
https://api.xxx.com/v1                → https://api.xxx.com
https://api.xxx.com/v1/               → https://api.xxx.com
https://api.xxx.com/v1/images/generations → https://api.xxx.com
https://api.xxx.com/openai/v1         → https://api.xxx.com/openai
api.xxx.com                           → https://api.xxx.com
```

随后所有请求都用 `buildUrl(base, 'models' | 'images/generations' | 'images/edits' | 'responses' | 'chat/completions')` 拼接，即 `<base>/v1/<endpoint>`。

## 2. 自动获取模型

1. `GET <base>/v1/models`，带 `Authorization: Bearer <key>`。
2. 若 404/非 JSON，再试 `<base>/models`（少数站把接口挂在根路径）。
3. 解析结构：`data[]` / `models[]` / `result[]` / `data.models[]` / 纯字符串数组，取 `id | model | name | slug`。
4. **图像模型筛选** `looksLikeImageModel()`：
   - 命中 `/(gpt-image|gpt_image|dall-?e|image|flux|sd\d|stable-diffusion|midjourney|nano-banana|seedream|kolors|hunyuan-image|qwen-image|wanx|glm-image|cogview|ideogram|recraft|imagen|sora-image|kling)/i`
   - 且不含 `/(embedding|whisper|tts|audio|speech|rerank|moderation|vision-only)/i`
5. **排序** `rankImageModel()`：`gpt-image-2`(0) → `gpt-image-2*`(1) → 其它 `gpt-image`(2) → `dall-e-3`(3) → 其它 `dall-e`(4) → 主流第三方图像模型(5) → 其余(6)。
6. 拉取失败时返回 `ok:false` + 内置候选 `['gpt-image-2','gpt-image-2-vip','gpt-image-1','gpt-image-1-mini','dall-e-3','dall-e-2']`，界面允许手填。

## 3. 生图调用链（单次提交）

```
文生图：images/generations（默认）
图生图：images/edits（默认 multipart；可在设置中选择 JSON）
```

- 用户显式选择"调用方式"时只走选定的那一种，不再试探。
- 包括 `404/405`、超时和返回无图在内的所有失败都停止本次操作，不再切换接口或格式自动重发。
- `attempts[]` 记录唯一的一次尝试。切换到 `chat`、`responses` 或其他编辑格式需要用户手动选择后重新提交。

### 请求体构造

```jsonc
// images/generations（仅下发模型支持的参数）
{ "model": "gpt-image-2", "prompt": "...", "n": 1, "size": "1024x1024",
  "quality": "high", "background": "auto→省略",
  "output_format": "png（仅 gpt-image* 模型下发）", "moderation": "low（可选）" }
```

```
// images/edits（multipart）
model / prompt / n / size / quality / background / output_format
image=<文件>   ← 参考图，可重复 10 次，顺序即"图1/图2…"
```

```jsonc
// responses
{ "model": "gpt-image-2", "input": "...",
  "tools": [{ "type": "image_generation", "size": "...", "quality": "...", "output_format": "..." }] }
```

## 4. 结果抽取 `relay.extractImages()`

递归遍历返回 JSON，收集以下任意形态（自动去重）：

- `b64_json`、`image_base64`、`base64`（长度 > 256 才认为是图片）、`result`（base64 或 dataURL 或 URL）
- `image_url`、`url`（http/https 或 data:image）、`data:image/...` 字符串
- markdown 图片语法 `![](https://...)`（chat 接口常见）
- 嵌套在 `output[]` / `item` / `data[]` / `choices[].message.content` 等任意层级

`usage` 抽取同时兼容 `usage` 与 `response.usage`，含 `output_tokens_details.image_tokens`。

## 5. 流式（SSE）

上游 `content-type: text/event-stream` 时逐事件解析：

- `*.partial_image` → 取出 `b64_json | partial_image_b64 | item.result`，按 `partial_image_index` 作为槽位，实时推给前端（前端以模糊态显示，收到最终图后替换）。
- `*.completed` / `image_generation_call` → 取最终图、`usage`、文本。
- `error` → 若始终没拿到图，抛出可读错误。

本工具自己的前端也用 SSE：`start` → `phase`（当前尝试的接口）→ `partial`（预览帧）→ `done` / `error`，另有 10 秒一次的注释心跳 `": ping"` 保持连接。

## 6. 安全

- `assertHostAllowed()`：默认拒绝私网/回环/链路本地地址（含 IPv6 `fc00::/7`、`fe80::/10`），自建中转需在界面显式开启。
- 转发给前端的配置里 `apiKey` 恒为空串，只给掩码 `apiKeyMasked`。
- 服务默认只绑 `127.0.0.1`。
