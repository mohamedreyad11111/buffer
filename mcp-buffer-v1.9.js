import { WorkflowEntrypoint } from "cloudflare:workers";

// mcp-buffer.js — v1.9 (Worker for HTTP + Workflow for the whole reasoning turn)
// Deploy via GitHub + Wrangler (a Workflow binding needs a real wrangler.jsonc).
//
// WHY THE WEBSOCKET IS GONE:
// v1.8's mistake: a single WebSocket is ONE Worker invocation for its entire
// life, and EVERY subrequest across EVERY chat turn in that session shares
// one budget — and per Cloudflare's own docs, Workflow binding calls
// (create()/status()) count as subrequests too ("a subrequest is any
// request a Worker makes using the Fetch API OR to Cloudflare services").
// So polling a Workflow's status from inside that same long-lived socket
// just traded one kind of subrequest for another, and polling every ~350ms
// actually burned through the budget FASTER than direct fetch() calls did.
//
// THE FIX: no more long-lived invocation at all. Each chat message is a
// plain short-lived HTTP request (POST /api/turn) that starts ONE Workflow
// instance for the ENTIRE plan→act→reflect→...→final turn, and returns
// immediately. The browser then polls a separate lightweight endpoint
// (GET /api/turn-status) every ~1.2s — and because each of THOSE polls is
// its own brand-new, short-lived Worker invocation, each one gets its own
// FRESH subrequest budget from zero. Total polls over a session can be any
// number; it no longer matters, because nothing is cumulative anymore.
// The actual heavy lifting (every Gemini call, every Buffer MCP call) runs
// as durable, auto-retried steps INSIDE the Workflow instance itself, which
// also gets its own separate subrequest budget from the polling Worker.
//
// TRADE-OFF, stated plainly: the live, char-by-char "thinking" stream from
// v1.5–v1.8 is gone — a WebSocket was the only way to push updates as they
// happen. What you get instead: the full plan/thought/action trace is still
// shown, just delivered all at once when the turn finishes, not one line at
// a time while it's running. Happy to help wire up a KV-backed progress log
// later if you want the live streaming feel back on top of this.
//
// Secrets to configure on Cloudflare (Settings → Variables and Secrets):
//   BUFFER_API_KEY, GEMINI_API_KEY, APP_USERNAME, APP_PASSWORD
// Bindings needed (see wrangler.jsonc): one Workflow binding, AGENT_WORKFLOW,
// pointing at the AgentTurnWorkflow class defined at the bottom of this file.
// No KV.

const MCP_URL = "https://mcp.buffer.com/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

const MAX_AGENT_STEPS = 24;
const SESSION_COOKIE = "buffer_agent_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout();
    }

    const authed = await isAuthenticated(request, env);

    if (url.pathname === "/api/turn" && request.method === "POST") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      return handleStartTurn(request, env);
    }

    if (url.pathname === "/api/turn-status" && request.method === "GET") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      return handleTurnStatus(request, env);
    }

    if (url.pathname === "/api/status") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      return jsonResponse({
        hasBufferKey: Boolean(env.BUFFER_API_KEY),
        hasGeminiKey: Boolean(env.GEMINI_API_KEY),
        hasWorkflow: Boolean(env.AGENT_WORKFLOW),
      });
    }

    if (url.pathname === "/") {
      return new Response(authed ? APP_HTML : LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Turn endpoints — this is the whole bridge to the Workflow now. No sockets,
// no server-side polling loop; the CLIENT polls, and each poll is its own
// fresh, short-lived invocation.
// ---------------------------------------------------------------------------

async function handleStartTurn(request, env) {
  if (!env.AGENT_WORKFLOW) {
    return jsonResponse({ error: "الـ Workflow binding AGENT_WORKFLOW مش موجود. راجع wrangler.jsonc." }, 500);
  }
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY مش متظبط في إعدادات الـ Worker (Secrets)." }, 500);
  }
  if (!env.BUFFER_API_KEY) {
    return jsonResponse({ error: "مفيش مفتاح Buffer API متظبط. ضيف Secret اسمه BUFFER_API_KEY." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  const contents = Array.isArray(body.contents) ? body.contents : [];
  if (!contents.length) {
    return jsonResponse({ error: "مفيش رسالة اتبعتت." }, 400);
  }

  const instance = await env.AGENT_WORKFLOW.create({ params: { contents: contents } });
  const instanceId = await instance.id;

  return jsonResponse({ instanceId: instanceId });
}

async function handleTurnStatus(request, env) {
  if (!env.AGENT_WORKFLOW) {
    return jsonResponse({ status: "errored", error: { message: "AGENT_WORKFLOW binding مش موجود." } }, 500);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return jsonResponse({ status: "errored", error: { message: "id ناقص." } }, 400);
  }

  const instance = await env.AGENT_WORKFLOW.get(id);
  const status = await instance.status();

  return jsonResponse(status);
}

// ---------------------------------------------------------------------------
// Auth: username/password login + signed session cookie (unchanged from
// v1.4 — this part had no bearing on the subrequest problem).
// ---------------------------------------------------------------------------

async function handleLogin(request, env) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD) {
    return jsonResponse(
      { ok: false, error: "الحساب مش متظبط في الـ Worker (APP_USERNAME/APP_PASSWORD)." },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
  }

  const username = body && body.username;
  const password = body && body.password;

  if (username !== env.APP_USERNAME || password !== env.APP_PASSWORD) {
    return jsonResponse({ ok: false, error: "اليوزر أو الباسورد غلط." }, 401);
  }

  const token = await createSessionToken(env, username);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    SESSION_COOKIE +
      "=" +
      token +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
      SESSION_MAX_AGE
  );
  return new Response(JSON.stringify({ ok: true }), { headers: headers });
}

function handleLogout() {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  return new Response(JSON.stringify({ ok: true }), { headers: headers });
}

async function isAuthenticated(request, env) {
  if (!env.APP_PASSWORD) return false;
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return false;
  return verifySessionToken(env, cookie);
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf("=");
    if (idx === -1) continue;
    const k = parts[i].slice(0, idx).trim();
    if (k === name) return decodeURIComponent(parts[i].slice(idx + 1).trim());
  }
  return null;
}

async function createSessionToken(env, username) {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_MAX_AGE * 1000 });
  const payloadB64 = bufToB64Url(new TextEncoder().encode(payload).buffer);
  const sig = await hmacSign(env.APP_PASSWORD, payloadB64);
  return payloadB64 + "." + sig;
}

async function verifySessionToken(env, token) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const payloadB64 = parts[0];
  const sig = parts[1];

  const valid = await hmacVerify(env.APP_PASSWORD, payloadB64, sig);
  if (!valid) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBuf(payloadB64)));
    if (!payload.exp || Date.now() > payload.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufToB64Url(sig);
}

async function hmacVerify(secret, message, signatureB64) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  try {
    return await crypto.subtle.verify("HMAC", key, b64UrlToBuf(signatureB64), enc.encode(message));
  } catch (e) {
    return false;
  }
}

function bufToB64Url(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBuf(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Raw MCP fetch (JSON-RPC 2.0 / Streamable HTTP) — called directly inside a
// Workflow step now, no wrapping needed since the Workflow instance already
// has its own execution context.
// ---------------------------------------------------------------------------

async function mcpFetchRaw(bufferKey, sessionId, method, params, isNotification) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + bufferKey,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = { jsonrpc: "2.0", method: method, params: params || {} };
  if (!isNotification) body.id = crypto.randomUUID();

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body),
  });

  const newSessionId = res.headers.get("Mcp-Session-Id") || sessionId || null;

  if (isNotification) {
    await res.text().catch(function () {});
    return { sessionId: newSessionId, result: null };
  }

  const contentType = res.headers.get("Content-Type") || "";
  let parsed = null;

  if (contentType.indexOf("text/event-stream") !== -1) {
    const raw = await res.text();
    parsed = parseSSE(raw);
  } else {
    parsed = await res.json();
  }

  if (!res.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || "MCP HTTP error " + res.status;
    throw new Error(msg);
  }
  if (parsed && parsed.error) {
    throw new Error(parsed.error.message || "MCP error");
  }

  return { sessionId: newSessionId, result: parsed ? parsed.result : null };
}

function parseSSE(raw) {
  const lines = raw.split("\n");
  let lastData = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("data:") === 0) {
      const jsonStr = line.slice(5).trim();
      if (jsonStr) {
        try {
          lastData = JSON.parse(jsonStr);
        } catch (e) {
          // ignore malformed lines
        }
      }
    }
  }
  return lastData;
}

async function callGeminiRaw(geminiKey, systemPrompt, contents) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || "Gemini API error (HTTP " + res.status + ")");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Local tools — actions the Workflow handles itself, not via Buffer's MCP.
// execute() takes only the tool args now (no server/env — no socket to push
// to anymore) and returns { text, video }. "video" is null unless this tool
// wants the client to render a video preview once the turn completes.
// ---------------------------------------------------------------------------

const LOCAL_TOOLS = {
  preview_video: {
    description:
      "Show the user a preview of a video from a direct video file URL (e.g. an .mp4 link). " +
      "Use this whenever the user shares a direct video link and asks to preview it, show it, " +
      "or remind them what's in it. This does NOT download the whole video — only enough " +
      "metadata to display it (like a YouTube-style preview), to minimize bandwidth.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Direct URL to the video file." } },
      required: ["url"],
    },
    execute: async function (args) {
      const url = args && args.url;
      if (!url || typeof url !== "string") {
        return { text: "محتاج رابط فيديو صالح عشان أعرض المعاينة.", video: null };
      }

      // Lightweight reachability/type check only — HEAD request, no video
      // bytes downloaded. This already runs inside the Workflow's own "act"
      // step, so no extra step wrapping is needed here.
      let ok = true;
      let contentType = "";
      try {
        const head = await fetch(url, { method: "HEAD" });
        ok = head.ok;
        contentType = head.headers.get("Content-Type") || "";
      } catch (e) {
        ok = false;
      }

      const text = ok
        ? "اتعرضت معاينة الفيديو للمستخدم في الشات (تحميل الميتاداتا بس، من غير تنزيل الملف كامل). Content-Type: " +
          (contentType || "غير معروف")
        : "الرابط اتبعت للواجهة عشان تحاول تعرضه، بس السيرفر مقدرش يتأكد منه بشكل مباشر (ممكن يشتغل عادي في المتصفح برضو).";

      // Render is always attempted client-side regardless of the HEAD check.
      return { text: text, video: url };
    },
  },
};

// ---------------------------------------------------------------------------
// System prompt — Plan-and-Solve + ReAct + Reflexion, built dynamically from
// whatever tools Buffer's MCP server currently exposes, plus LOCAL_TOOLS.
// ---------------------------------------------------------------------------

function buildSystemPrompt(mcpTools) {
  const mcpToolLines = mcpTools
    .map(function (t) {
      return (
        "- **" +
        t.name +
        "**: " +
        (t.description || "") +
        "\n  Parameters (JSON Schema): " +
        JSON.stringify(t.inputSchema || {})
      );
    })
    .join("\n\n");

  const localToolLines = Object.keys(LOCAL_TOOLS)
    .map(function (name) {
      const t = LOCAL_TOOLS[name];
      return (
        "- **" +
        name +
        "**: " +
        t.description +
        "\n  Parameters (JSON Schema): " +
        JSON.stringify(t.inputSchema)
      );
    })
    .join("\n\n");

  const toolLines = mcpToolLines + "\n\n" + localToolLines;

  return [
    "You are an assistant that manages a user's Buffer account (through Buffer's official MCP server) and can also do a few local things directly in this chat, like previewing videos.",
    "For Buffer actions you never call the API directly — you only ever call one of the tools listed below, and the system forwards it to the right place and gives you the result.",
    "Reply to the user in the same language they write in (Arabic or English).",
    "",
    "## Thinking architecture: Plan-and-Solve + ReAct + Reflexion",
    "",
    "You reason in explicit phases, one JSON object per turn — nothing else in the message, no markdown fences, no text outside the JSON.",
    "",
    "**1. plan** — do this once at the start of a new, non-trivial request. Break it into concrete steps before touching any tool.",
    '{"phase": "plan", "thought": "<brief reasoning about what is needed and why>", "steps": ["step 1", "step 2", "..."]}',
    "",
    "**2. act** — a ReAct step: call exactly one tool, with the reasoning behind it.",
    '{"phase": "act", "thought": "<why this call, what you expect back>", "name": "<tool_name>", "args": { ... }}',
    "You will receive the result as your next input, wrapped exactly like this:",
    '[FUNCTION_RESULT name="tool_name"]',
    "...result...",
    "[/FUNCTION_RESULT]",
    "",
    "**3. reflect** — a Reflexion step: after an observation, briefly judge whether it actually moved the plan forward, and self-correct rather than plough ahead on a bad assumption (wrong channel matched, unexpected error, empty result, stale ID, etc). Reserve this for calls whose outcome is genuinely uncertain, risky, or surprising.",
    '{"phase": "reflect", "thought": "<did this work as expected? anything to correct?>", "status": "on_track" | "revise"}',
    'If status is "revise", your next turn must be a corrected "plan" or "act" — not "final".',
    "",
    "**4. final** — only once the request is genuinely fully handled (or you need to ask the user something you cannot resolve yourself).",
    '{"phase": "final", "text": "<reply to the user, in their language, written as a normal chat message>"}',
    "",
    "Rules:",
    "- Always exactly one valid JSON object, every turn — never prose outside it.",
    "- One tool call per act step. Never invent a tool name outside the list below.",
    '- "thought" is a short internal note (one sentence) — it is shown to the user as a lightweight reasoning trace, so keep it clean of raw IDs, tokens, or secrets.',
    "- Before an irreversible action (creating/scheduling/deleting a post), make sure your plan/reflect already resolved the exact channel and timing — don't guess silently on ambiguous requests, ask via `final` instead.",
    "- If the user shares a direct video link and wants to preview/see/remember it, call `preview_video` — after calling it, the video is already shown to the user in the chat, so your `final` reply should just briefly comment on it (you don't need to describe it since you haven't actually watched it — just acknowledge it's shown), not repeat the URL.",
    "- If a tool result contains an error, don't pretend it succeeded — reflect on it, and either correct the call or explain the problem to the user via `final` in plain language.",
    "- Be economical: every `act` is a real network call with a real cost. For a simple, unambiguous, single-step request, skip straight from `plan` (or even skip `plan` entirely) to one `act` and then `final`. Save deliberate multi-step plan → act → reflect cycles for requests that actually have several real parts.",
    "",
    "## Available tools (Buffer tools live from MCP + local tools)",
    "",
    toolLines,
  ].join("\n");
}

function parseAgentResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) cleaned = fenced[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared head (Tabler icons + IBM Plex font — used by both login and app pages)
// ---------------------------------------------------------------------------

const ICON_LINK =
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css" />';

const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">';

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <g fill="none" stroke="#191919" stroke-width="22" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M 115,18 L 50,18 A 32,32 0 0,0 18,50 L 18,92" />
    <path d="M 18,108 L 18,150 A 32,32 0 0,0 50,182 L 82,182 L 82,148" />
    <path d="M 118,52 L 118,18 L 150,18 A 32,32 0 0,1 182,50 L 182,92" />
    <path d="M 182,108 L 182,150 A 32,32 0 0,1 150,182 L 100,182" />
  </g>
</svg>`;

const SHARED_STYLE = `
  :root{
    --bg:#ffffff; --surface:#f5f5f5; --border:#ececec;
    --ink:#0a0a0a; --muted:#9a9a9a; --muted-2:#c9c9c9;
    --danger:#dc2626; --danger-bg:#fdf0f0;
  }
  *{ box-sizing:border-box; }
  input, button, textarea, select{ font-family:inherit; }
  html,body{ height:100%; margin:0; }
  body{
    background:var(--bg); color:var(--ink);
    font-family:"IBM Plex Sans Arabic","IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
`;

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>تسجيل الدخول — Islam Agent</title>
${ICON_LINK}
${FONT_LINK}
<style>
${SHARED_STYLE}
  body{ display:flex; align-items:center; justify-content:center; min-height:100%; padding:24px; }
  .card{
    width:100%; max-width:360px;
    display:flex; flex-direction:column; align-items:center;
    animation:rise .35s ease;
  }
  @keyframes rise{ from{opacity:0; transform:translateY(8px);} to{opacity:1; transform:translateY(0);} }

  .mark{
    width:48px; height:48px;
    display:flex; align-items:center; justify-content:center;
    margin-bottom:18px;
  }
  h1{ font-size:16px; font-weight:600; margin:0 0 4px; letter-spacing:.01em; }
  .sub{ font-size:12.5px; color:var(--muted); margin:0 0 28px; }

  form{ width:100%; display:flex; flex-direction:column; gap:10px; }
  .field{
    display:flex; align-items:center; gap:10px;
    background:var(--surface); border-radius:12px; padding:0 14px;
    transition:box-shadow .2s;
  }
  .field:focus-within{ box-shadow:0 0 0 1.5px var(--ink) inset; }
  .field i{ color:var(--muted); font-size:17px; }
  .field input{
    flex:1; border:none; background:transparent; outline:none;
    padding:13px 0; font-size:14.5px; color:var(--ink);
  }
  .field input::placeholder{ color:var(--muted-2); }

  button{
    margin-top:6px; border:none; background:var(--ink); color:#fff;
    padding:13px; border-radius:12px; font-size:14.5px; font-weight:600;
    cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;
    transition:opacity .2s, transform .15s;
  }
  button:active{ transform:scale(.98); }
  button:disabled{ opacity:.5; cursor:not-allowed; }

  .error{
    font-size:12.5px; color:var(--danger); background:var(--danger-bg);
    border-radius:10px; padding:9px 12px; display:none; align-items:center; gap:6px;
  }
  .error.show{ display:flex; }
  .error i{ font-size:15px; color:var(--danger); }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${LOGO_SVG}</div>
    <h1>Islam Agent</h1>
    <p class="sub">سجّل دخولك للمتابعة</p>

    <form id="login-form">
      <div class="field">
        <i class="ti ti-user"></i>
        <input type="text" id="username" placeholder="اليوزر" autocomplete="username" />
      </div>
      <div class="field">
        <i class="ti ti-lock"></i>
        <input type="password" id="password" placeholder="الباسورد" autocomplete="current-password" />
      </div>
      <div class="error" id="error"><i class="ti ti-alert-circle"></i><span id="error-text"></span></div>
      <button type="submit" id="submit-btn"><i class="ti ti-arrow-left"></i> دخول</button>
    </form>
  </div>

<script>
  var form = document.getElementById("login-form");
  var usernameEl = document.getElementById("username");
  var passwordEl = document.getElementById("password");
  var errorEl = document.getElementById("error");
  var errorTextEl = document.getElementById("error-text");
  var submitBtn = document.getElementById("submit-btn");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.classList.remove("show");
    submitBtn.disabled = true;

    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameEl.value, password: passwordEl.value }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (res.ok && res.data.ok) {
          location.reload();
        } else {
          errorTextEl.textContent = (res.data && res.data.error) || "حصل خطأ، جرب تاني.";
          errorEl.classList.add("show");
          submitBtn.disabled = false;
        }
      })
      .catch(function () {
        errorTextEl.textContent = "معرفناش نوصل للسيرفر.";
        errorEl.classList.add("show");
        submitBtn.disabled = false;
      });
  });
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// App page (chat UI) — no WebSocket: sends a message, gets an instance id,
// polls for it. Same visual design as before.
// ---------------------------------------------------------------------------

const APP_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Islam Agent</title>
${ICON_LINK}
${FONT_LINK}
<style>
${SHARED_STYLE}
  body{ display:flex; flex-direction:column; overflow:hidden; }

  .header-left{
    position:fixed; top:16px; left:22px; z-index:5;
    width:24px; height:24px;
  }
  .header-right{
    position:fixed; top:13px; right:16px; z-index:5;
    display:flex; align-items:center; gap:2px;
  }
  .header-btn{
    display:flex; align-items:center; gap:6px;
    background:transparent; border:none; cursor:pointer;
    color:var(--muted); font-size:12.5px;
    padding:9px 12px; border-radius:10px;
    transition:background .15s, color .15s;
  }
  .header-btn:hover{ background:var(--surface); color:var(--ink); }
  .header-btn i{ font-size:15px; }

  .scroll{ flex:1; overflow-y:auto; display:flex; justify-content:center; }
  .thread{
    width:100%; max-width:640px;
    padding:70px 24px 20px;
    display:flex; flex-direction:column; gap:18px;
  }

  @keyframes rise{ from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:translateY(0);} }

  .row{ display:flex; animation:rise .28s ease; }
  .row.user{ justify-content:flex-start; }
  .row.agent{ justify-content:flex-start; }

  .bubble{
    max-width:80%; padding:12px 16px; border-radius:16px;
    font-size:14.5px; line-height:1.68; white-space:pre-wrap; word-wrap:break-word;
    direction:rtl; text-align:right;
  }
  .row.user .bubble{ background:var(--surface); color:var(--ink); border-bottom-left-radius:4px; }
  .row.agent .bubble{ background:var(--bg); color:var(--ink); border-bottom-right-radius:4px; width:100%; max-width:100%; }

  .system-note{
    align-self:center; color:var(--muted); font-size:12px; text-align:center; max-width:85%;
  }
  .error-note{
    align-self:flex-start; max-width:80%; font-size:13px; color:var(--danger);
    display:flex; align-items:flex-start; gap:8px; direction:rtl; text-align:right;
    border-right:2px solid var(--danger); padding:9px 14px; background:var(--danger-bg); border-radius:10px;
  }
  .error-note i{ font-size:15px; margin-top:1px; color:var(--danger); }

  .trace{ align-self:flex-start; max-width:82%; display:flex; flex-direction:column; gap:6px; animation:rise .25s ease; }
  .trace-line{ display:flex; align-items:baseline; gap:8px; font-size:12px; color:var(--muted); line-height:1.6; direction:rtl; text-align:right; }
  .trace-line .tag{
    flex-shrink:0; display:inline-flex; align-items:center; gap:4px;
    font-size:10.5px; color:var(--muted); border:1px solid var(--border); border-radius:6px;
    padding:2px 7px; letter-spacing:.02em;
  }
  .trace-line .tag i{ font-size:11px; }

  .plan-card{
    align-self:flex-start; max-width:82%;
    background:var(--bg); border:1px solid var(--border); border-radius:14px;
    padding:13px 16px; font-size:12.5px; color:var(--muted);
  }
  .plan-card .plan-title{ display:flex; align-items:center; gap:6px; font-size:11px; letter-spacing:.03em; color:var(--muted); }
  .plan-card ol{ margin:8px 0 0; padding-inline-start:18px; }
  .plan-card li{ margin:4px 0; color:var(--ink); }

  .video-card{
    align-self:flex-start; max-width:82%; width:340px;
    background:var(--surface); border-radius:16px; padding:8px; animation:rise .3s ease;
  }
  .video-card video{
    width:100%; display:block; border-radius:10px; background:#000;
    max-height:340px;
  }
  .video-card .video-caption{
    display:flex; align-items:center; gap:6px;
    font-size:11.5px; color:var(--muted); padding:8px 6px 2px;
  }
  .video-card .video-caption i{ font-size:13px; }

  .typing{ align-self:flex-start; display:flex; align-items:center; gap:5px; padding:6px 2px; }
  .typing span{ width:5px; height:5px; border-radius:50%; background:var(--muted-2); animation:blink 1.3s infinite; }
  .typing span:nth-child(2){ animation-delay:.2s; }
  .typing span:nth-child(3){ animation-delay:.4s; }
  @keyframes blink{ 0%,80%,100%{opacity:.3} 40%{opacity:1} }

  .input-zone{ position:relative; display:flex; justify-content:center; padding:14px 24px 18px; }
  .input-zone::before{
    content:""; position:absolute; left:0; right:0; top:-36px; height:36px;
    background:linear-gradient(to top, #ffffff, rgba(255,255,255,0));
    pointer-events:none;
  }
  .composer{
    position:relative; width:100%; max-width:640px;
    display:flex; align-items:flex-end; gap:10px;
    background:var(--surface); border-radius:22px; padding:8px 10px 8px 18px;
  }
  .avatar{
    flex-shrink:0; width:26px; height:26px;
    display:flex; align-items:center; justify-content:center;
    margin-bottom:6px;
  }
  textarea{
    flex:1; resize:none; border:none; background:transparent; outline:none;
    font-size:14.5px; color:var(--ink); max-height:120px;
    direction:rtl; text-align:right;
    padding:9px 0; line-height:1.5;
  }
  textarea::placeholder{ color:var(--muted-2); }
  .send-btn{
    flex-shrink:0; width:38px; height:38px; border-radius:50%;
    background:var(--ink); color:#fff; border:none; cursor:pointer;
    display:flex; align-items:center; justify-content:center; font-size:16px;
    transition:opacity .2s, transform .15s;
  }
  .send-btn:active{ transform:scale(.92); }
  .send-btn:disabled{ opacity:.25; cursor:not-allowed; }

  ::-webkit-scrollbar{ width:8px; }
  ::-webkit-scrollbar-thumb{ background:var(--border); border-radius:8px; }
</style>
</head>
<body>
  <div class="header-left">${LOGO_SVG}</div>
  <div class="header-right">
    <button class="header-btn" id="new-chat-btn" title="محادثة جديدة"><i class="ti ti-message-plus"></i> محادثة جديدة</button>
    <button class="header-btn" id="logout-btn" title="تسجيل الخروج"><i class="ti ti-logout-2"></i> تسجيل الخروج</button>
  </div>

  <div class="scroll"><div class="thread" id="thread">
    <div class="system-note">اكتب طلبك، وهيتنفذ فعليًا على Buffer عن طريق MCP.</div>
  </div></div>

  <div class="input-zone">
    <form class="composer" id="composer-form">
      <div class="avatar">${LOGO_SVG}</div>
      <textarea id="input" rows="1" placeholder="اكتب رسالتك..."></textarea>
      <button type="submit" class="send-btn" id="send-btn"><i class="ti ti-arrow-up"></i></button>
    </form>
  </div>

<script>
  var thread = document.getElementById("thread");
  var scrollBox = document.querySelector(".scroll");
  var form = document.getElementById("composer-form");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send-btn");
  var logoutBtn = document.getElementById("logout-btn");
  var newChatBtn = document.getElementById("new-chat-btn");

  var contents = [];   // conversation history, client-owned (Gemini "contents" shape)
  var busy = false;    // true while a turn is in flight
  var POLL_MS = 1200;

  var PHASE_META = {
    plan:    { label: "خطة",     icon: "ti-list-check" },
    act:     { label: "إجراء",   icon: "ti-bolt" },
    reflect: { label: "مراجعة",  icon: "ti-refresh" }
  };

  function scrollDown() { scrollBox.scrollTop = scrollBox.scrollHeight; }

  function addBubble(text, kind) {
    var row = document.createElement("div");
    row.className = "row " + kind;
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    row.appendChild(bubble);
    thread.appendChild(row);
    scrollDown();
  }

  function addError(text) {
    var div = document.createElement("div");
    div.className = "error-note";
    div.innerHTML = '<i class="ti ti-alert-triangle"></i><span></span>';
    div.querySelector("span").textContent = text;
    thread.appendChild(div);
    scrollDown();
  }

  function addTraceGroup(traceArr) {
    if (!traceArr || !traceArr.length) return;
    var wrap = document.createElement("div");
    wrap.className = "trace";
    for (var i = 0; i < traceArr.length; i++) {
      var item = traceArr[i];
      var meta = PHASE_META[item.phase] || { label: item.phase, icon: "ti-point" };
      var line = document.createElement("div");
      line.className = "trace-line";
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.innerHTML = '<i class="ti ' + meta.icon + '"></i> ' + meta.label;
      var span = document.createElement("span");
      span.textContent = item.text;
      line.appendChild(tag);
      line.appendChild(span);
      wrap.appendChild(line);
    }
    thread.appendChild(wrap);
    scrollDown();
  }

  function addPlanCard(steps) {
    if (!steps || !steps.length) return;
    var card = document.createElement("div");
    card.className = "plan-card";
    var title = document.createElement("div");
    title.className = "plan-title";
    title.innerHTML = '<i class="ti ti-route"></i> الخطة';
    var ol = document.createElement("ol");
    for (var i = 0; i < steps.length; i++) {
      var li = document.createElement("li");
      li.textContent = steps[i];
      ol.appendChild(li);
    }
    card.appendChild(title);
    card.appendChild(ol);
    thread.appendChild(card);
    scrollDown();
  }

  function addVideoCard(url) {
    var card = document.createElement("div");
    card.className = "video-card";
    var video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    var caption = document.createElement("div");
    caption.className = "video-caption";
    caption.innerHTML = '<i class="ti ti-player-play"></i> معاينة فيديو';
    card.appendChild(video);
    card.appendChild(caption);
    thread.appendChild(card);
    scrollDown();
  }

  var typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("div");
    typingEl.className = "typing";
    typingEl.innerHTML = "<span></span><span></span><span></span>";
    thread.appendChild(typingEl);
    scrollDown();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  form.addEventListener("submit", function (e) { e.preventDefault(); sendCurrent(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  function sendCurrent() {
    var text = input.value.trim();
    if (!text || busy) return;

    addBubble(text, "user");
    contents.push({ role: "user", parts: [{ text: text }] });
    input.value = "";
    input.style.height = "auto";

    startTurn();
  }

  function startTurn() {
    busy = true;
    sendBtn.disabled = true;
    showTyping();

    fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: contents }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.instanceId) throw new Error(data.error || "معرفناش نبدأ الطلب.");
        pollTurn(data.instanceId);
      })
      .catch(function (err) {
        hideTyping();
        busy = false;
        sendBtn.disabled = false;
        addError("حصل خطأ: " + (err && err.message ? err.message : "غير معروف"));
      });
  }

  function pollTurn(id) {
    fetch("/api/turn-status?id=" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === "complete") {
          hideTyping();
          var out = data.output || {};
          if (out.plan && out.plan.length) addPlanCard(out.plan);
          if (out.trace && out.trace.length) addTraceGroup(out.trace);
          if (out.video) addVideoCard(out.video);
          if (out.finalText) addBubble(out.finalText, "agent");
          if (Array.isArray(out.contents)) contents = out.contents;
          busy = false;
          sendBtn.disabled = false;
          return;
        }
        if (data.status === "errored" || data.status === "terminated") {
          hideTyping();
          var msg = (data.error && data.error.message) || "حصل خطأ غير متوقع.";
          var isLimit = /subrequest/i.test(msg);
          addError(isLimit ? "الطلب استهلك حد الطلبات المسموح بيه. جرب تاني أو ابسّط الطلب." : ("حصل خطأ: " + msg));
          busy = false;
          sendBtn.disabled = false;
          return;
        }
        // still "running" or "queued" — keep polling
        setTimeout(function () { pollTurn(id); }, POLL_MS);
      })
      .catch(function () {
        // transient network hiccup while polling — just retry, don't fail the turn
        setTimeout(function () { pollTurn(id); }, POLL_MS + 800);
      });
  }

  logoutBtn.addEventListener("click", function () {
    fetch("/api/logout", { method: "POST" }).then(function () { location.reload(); });
  });

  newChatBtn.addEventListener("click", function () {
    if (busy) return;
    contents = [];
    thread.innerHTML = '<div class="system-note">اكتب طلبك، وهيتنفذ فعليًا على Buffer عن طريق MCP.</div>';
  });

  fetch("/api/status").catch(function () {}); // warms nothing critical; status not shown in this layout
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// The Workflow — one instance handles ONE full chat turn: fresh MCP session,
// then the whole plan → act → reflect → ... → final loop, each Gemini/MCP
// call as its own durable, auto-retried step. class_name in wrangler.jsonc
// MUST be exactly "AgentTurnWorkflow".
// ---------------------------------------------------------------------------

export class AgentTurnWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = (event && event.payload) || {};
    const contents = Array.isArray(payload.contents) ? payload.contents.slice() : [];

    const bufferKey = this.env.BUFFER_API_KEY;
    const geminiKey = this.env.GEMINI_API_KEY;
    if (!bufferKey) throw new Error("مفيش مفتاح Buffer API متظبط (BUFFER_API_KEY).");
    if (!geminiKey) throw new Error("مفيش مفتاح Gemini متظبط (GEMINI_API_KEY).");

    // --- Fresh MCP session every turn: simple, stateless, no stale-session risk ---
    const initResult = await step.do("mcp-initialize", async () => {
      return mcpFetchRaw(
        bufferKey,
        null,
        "initialize",
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cf-buffer-agent", version: "1.9" } },
        false
      );
    });
    const sessionId = initResult.sessionId;

    await step.do("mcp-notify-initialized", async () => {
      return mcpFetchRaw(bufferKey, sessionId, "notifications/initialized", {}, true);
    });

    const toolsResult = await step.do("mcp-tools-list", async () => {
      return mcpFetchRaw(bufferKey, sessionId, "tools/list", {}, false);
    });
    const mcpTools = (toolsResult.result && toolsResult.result.tools) || [];
    const systemPrompt = buildSystemPrompt(mcpTools);

    // --- Reasoning loop ---
    const trace = [];
    let plan = null;
    let video = null;
    let finalText = null;

    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      const geminiData = await step.do("gemini-" + i, async () => {
        return callGeminiRaw(geminiKey, systemPrompt, contents);
      });

      const candidate = geminiData.candidates && geminiData.candidates[0];
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      const rawText = parts.map(function (p) { return p.text || ""; }).join("").trim();

      contents.push({ role: "model", parts: [{ text: rawText }] });

      const parsed = parseAgentResponse(rawText);

      if (!parsed || !parsed.phase) {
        finalText = rawText || "معلش، مش قادر أرد دلوقتي. جرب تاني.";
        break;
      }

      if (parsed.thought && typeof parsed.thought === "string") {
        trace.push({ phase: parsed.phase, text: parsed.thought });
      }

      if (parsed.phase === "plan" && Array.isArray(parsed.steps)) {
        plan = parsed.steps;
        contents.push({ role: "user", parts: [{ text: "[SYSTEM] الخطة اتسجلت. كمّل بأول خطوة (act) دلوقتي." }] });
        continue;
      }

      if (parsed.phase === "act" && typeof parsed.name === "string") {
        const toolName = parsed.name;
        const toolArgs = parsed.args || {};

        const actResult = await step.do("act-" + i, async () => {
          try {
            if (LOCAL_TOOLS[toolName]) {
              return await LOCAL_TOOLS[toolName].execute(toolArgs);
            }
            const callResult = await mcpFetchRaw(bufferKey, sessionId, "tools/call", { name: toolName, arguments: toolArgs }, false);
            const result = callResult.result || {};
            const blocks = result.content || [];
            const text = blocks
              .filter(function (b) { return b.type === "text"; })
              .map(function (b) { return b.text; })
              .join("\n");
            if (result.isError) throw new Error(text || "Buffer MCP tool returned an error");
            return { text: text || JSON.stringify(result), video: null };
          } catch (err) {
            return { text: "ERROR: " + (err && err.message ? err.message : "unknown error"), video: null };
          }
        });

        if (actResult.video) video = actResult.video;

        contents.push({
          role: "user",
          parts: [{ text: '[FUNCTION_RESULT name="' + toolName + '"]\n' + actResult.text + "\n[/FUNCTION_RESULT]" }],
        });
        continue;
      }

      if (parsed.phase === "reflect") {
        contents.push({ role: "user", parts: [{ text: "[SYSTEM] تم تسجيل المراجعة. كمّل." }] });
        continue;
      }

      if (parsed.phase === "final" && typeof parsed.text === "string") {
        finalText = parsed.text;
        break;
      }

      finalText = rawText || "معلش، مش قادر أرد دلوقتي. جرب تاني.";
      break;
    }

    if (finalText === null) {
      finalText = "الطلب محتاج خطوات كتير قوي، ممكن تبسطه أو تقسمه؟";
    }

    return { finalText: finalText, trace: trace, plan: plan, video: video, contents: contents };
  }
}
