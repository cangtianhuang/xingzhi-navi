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

  // 把一段自由文字拆成结构化条目（用于批量建图）
  async function plan(text) {
    const c = getConfig();
    if (!c.apiKey) throw new Error("还没填 API Key");
    const sys =
      "你是任务梳理助手。用户给你一段关于近况 / 待办的中文文字，你把它拆成结构化条目。" +
      "只输出一个 JSON 数组，不要多余文字，不要代码块围栏。" +
      '每项形如 {"domain":"work","project":"项目名","task":"具体的一件事","brief":"一句现状（可空）","nextAction":"下一步动作（可空，动词开头）","estimateMin":30}。' +
      "domain 必须四选一：work（工作）/ study（学习）/ life（生活）/ proj（项目）。" +
      "task 是最小可执行的一件事，一句话；同一 project 可以有多条 task 拆成多项。" +
      "estimateMin 是预计分钟的数字，拿不准就给 25。最多输出 20 项。";
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.apiKey },
      body: JSON.stringify({
        model: c.model || DEFAULT_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: String(text || "").slice(0, 2000) },
        ],
        temperature: 0.4,
        max_tokens: 1200,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("请求失败 HTTP " + res.status + (body ? "：" + body.slice(0, 160) : ""));
    }
    const data = await res.json();
    const txt = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    return parseArray(txt);
  }

  // 从模型输出里取出 JSON 数组，容忍代码块围栏
  function parseArray(text) {
    let raw = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const s = raw.indexOf("[");
    const e = raw.lastIndexOf("]");
    if (s >= 0 && e > s) {
      try {
        const arr = JSON.parse(raw.slice(s, e + 1));
        return Array.isArray(arr) ? arr : [];
      } catch (err) {
        return [];
      }
    }
    return [];
  }

  return { getConfig, setConfig, isReady, suggest, plan, DEFAULT_URL, DEFAULT_MODEL };
})();
