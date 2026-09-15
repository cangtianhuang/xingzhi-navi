/**
 * OneAPI（OpenAI 兼容）接入：给节点生成「下一步」建议。
 * 纯浏览器直连，配置（base url / api key / model）存在本地 localStorage。
 * 注意：api key 明文存在浏览器本地，仅适合内网 / 本地 Demo 使用。
 */
window.NaviAI = (function () {
  const KEY = "xingzhi-navi-ai-v1";
  const DEFAULT_URL = "https://oneapi-comate.baidu-int.com/v1";
  const DEFAULT_MODEL = "gpt-4o-mini";

  const SYSTEM =
    "你是一个务实的行动助手。用户给你一件事的现状，你只回一步「现在最该做的、能立刻上手的具体动作」。" +
    "要求：中文；动作一句话不超过 30 字，动词开头，具体可执行；提示一句话不超过 50 字，说清怎么做或注意什么。" +
    '只输出 JSON，形如 {"action":"...","hint":"..."}，不要多余文字。';

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function setConfig(c) {
    try {
      localStorage.setItem(KEY, JSON.stringify(c || {}));
    } catch (e) {}
  }

  function isReady() {
    return !!getConfig().apiKey;
  }

  function endpoint() {
    const base = (getConfig().baseUrl || DEFAULT_URL).replace(/\/+$/, "");
    return base + "/chat/completions";
  }

  async function suggest(prompt) {
    const c = getConfig();
    if (!c.apiKey) throw new Error("还没填 API Key");
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.apiKey },
      body: JSON.stringify({
        model: c.model || DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("请求失败 HTTP " + res.status + (body ? "：" + body.slice(0, 160) : ""));
    }
    const data = await res.json();
    const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    return parse(text);
  }

  // 尽量从模型输出里取出 {action, hint}，容忍代码块包裹或纯文本
  function parse(text) {
    let raw = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        const obj = JSON.parse(raw.slice(s, e + 1));
        return { action: (obj.action || "").trim(), hint: (obj.hint || "").trim() };
      } catch (err) {
        /* fall through */
      }
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    return { action: lines[0] || raw, hint: lines[1] || "" };
  }

  return { getConfig, setConfig, isReady, suggest, DEFAULT_URL, DEFAULT_MODEL };
})();
