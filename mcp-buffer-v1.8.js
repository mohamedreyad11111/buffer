import { WorkflowEntrypoint } from "cloudflare:workers";

// mcp-buffer.js — v2.0 (PURE WORKFLOW ARCHITECTURE)
// No WebSockets. No long-lived invocations. 100% Serverless & Stateless.

const MCP_URL = "https://mcp.buffer.com/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

const SESSION_COOKIE = "buffer_agent_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

// ---------------------------------------------------------------------------
// Worker entry point (Stateless API Gateway)
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

    // API: Start a new workflow instance for a chat message
    if (url.pathname === "/api/chat/start" && request.method === "POST") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      
      if (!env.AGENT_WORKFLOW) {
        return jsonResponse({ error: "AGENT_WORKFLOW binding missing" }, 500);
      }

      const instance = await env.AGENT_WORKFLOW.create({ params: body });
      return jsonResponse({ workflowId: instance.id });
    }

    // API: Check workflow status
    if (url.pathname === "/api/chat/status" && request.method === "GET") {
      if (!authed) return new Response("Unauthorized", { status: 401 });
      const id = url.searchParams.get("id");
      if (!id) return jsonResponse({ error: "Missing workflow ID" }, 400);

      const instance = await env.AGENT_WORKFLOW.get(id);
      const status = await instance.status();
      return jsonResponse(status);
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
// Auth functions (Unchanged)
// ---------------------------------------------------------------------------

async function handleLogin(request, env) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD) {
    return jsonResponse({ ok: false, error: "Missing APP_USERNAME/APP_PASSWORD." }, 500);
  }
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: "invalid JSON" }, 400); }
  
  if (body.username !== env.APP_USERNAME || body.password !== env.APP_PASSWORD) {
    return jsonResponse({ ok: false, error: "اليوزر أو الباسورد غلط." }, 401);
  }

  const token = await createSessionToken(env, body.username);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_MAX_AGE
  );
  return new Response(JSON.stringify({ ok: true }), { headers: headers });
}

function handleLogout() {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
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
    if (parts[i].slice(0, idx).trim() === name) return decodeURIComponent(parts[i].slice(idx + 1).trim());
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
  const valid = await hmacVerify(env.APP_PASSWORD, parts[0], parts[1]);
  if (!valid) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBuf(parts[0])));
    if (!payload.exp || Date.now() > payload.exp) return false;
    return true;
  } catch (e) { return false; }
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bufToB64Url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function hmacVerify(secret, message, signatureB64) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  try { return await crypto.subtle.verify("HMAC", key, b64UrlToBuf(signatureB64), enc.encode(message)); } 
  catch (e) { return false; }
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
// Shared Head & UI Layout
// ---------------------------------------------------------------------------

const ICON_LINK = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css" />';
const FONT_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">';
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <g fill="none" stroke="#191919" stroke-width="22" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M 115,18 L 50,18 A 32,32 0 0,0 18,50 L 18,92" />
    <path d="M 18,108 L 18,150 A 32,32 0 0,0 50,182 L 82,182 L 82,148" />
    <path d="M 118,52 L 118,18 L 150,18 A 32,32 0 0,1 182,50 L 182,92" />
    <path d="M 182,108 L 182,150 A 32,32 0 0,1 150,182 L 100,182" />
  </g>
</svg>`;

const SHARED_STYLE = `
  :root{ --bg:#ffffff; --surface:#f5f5f5; --border:#ececec; --ink:#0a0a0a; --muted:#9a9a9a; --muted-2:#c9c9c9; --danger:#dc2626; --danger-bg:#fdf0f0; }
  *{ box-sizing:border-box; } input, button, textarea, select{ font-family:inherit; } html,body{ height:100%; margin:0; }
  body{ background:var(--bg); color:var(--ink); font-family:"IBM Plex Sans Arabic","IBM Plex Sans",sans-serif; -webkit-font-smoothing:antialiased; }
`;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>تسجيل الدخول — Islam Agent</title>${ICON_LINK}${FONT_LINK}
<style>
${SHARED_STYLE}
  body{ display:flex; align-items:center; justify-content:center; min-height:100%; padding:24px; }
  .card{ width:100%; max-width:360px; display:flex; flex-direction:column; align-items:center; animation:rise .35s ease; }
  @keyframes rise{ from{opacity:0; transform:translateY(8px);} to{opacity:1; transform:translateY(0);} }
  .mark{ width:48px; height:48px; display:flex; align-items:center; justify-content:center; margin-bottom:18px; }
  h1{ font-size:16px; font-weight:600; margin:0 0 4px; } .sub{ font-size:12.5px; color:var(--muted); margin:0 0 28px; }
  form{ width:100%; display:flex; flex-direction:column; gap:10px; }
  .field{ display:flex; align-items:center; gap:10px; background:var(--surface); border-radius:12px; padding:0 14px; }
  .field:focus-within{ box-shadow:0 0 0 1.5px var(--ink) inset; }
  .field i{ color:var(--muted); font-size:17px; }
  .field input{ flex:1; border:none; background:transparent; outline:none; padding:13px 0; font-size:14.5px; color:var(--ink); }
  button{ margin-top:6px; border:none; background:var(--ink); color:#fff; padding:13px; border-radius:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; }
  .error{ font-size:12.5px; color:var(--danger); background:var(--danger-bg); border-radius:10px; padding:9px 12px; display:none; align-items:center; gap:6px; }
  .error.show{ display:flex; }
</style></head><body>
  <div class="card">
    <div class="mark">${LOGO_SVG}</div><h1>Islam Agent</h1><p class="sub">سجّل دخولك للمتابعة</p>
    <form id="login-form">
      <div class="field"><i class="ti ti-user"></i><input type="text" id="username" placeholder="اليوزر" /></div>
      <div class="field"><i class="ti ti-lock"></i><input type="password" id="password" placeholder="الباسورد" /></div>
      <div class="error" id="error"><i class="ti ti-alert-circle"></i><span id="error-text"></span></div>
      <button type="submit" id="submit-btn">دخول</button>
    </form>
  </div>
<script>
  document.getElementById("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const u = document.getElementById("username").value;
    const p = document.getElementById("password").value;
    const res = await fetch("/api/login", { method: "POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({username:u, password:p}) });
    const data = await res.json();
    if(res.ok && data.ok) location.reload(); else { document.getElementById("error").classList.add("show"); document.getElementById("error-text").textContent = data.error || "خطأ"; }
  });
</script></body></html>`;

// ---------------------------------------------------------------------------
// App Page (Stateless Polling Architecture - No WebSocket)
// ---------------------------------------------------------------------------

const APP_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Islam Agent</title>${ICON_LINK}${FONT_LINK}
<style>
${SHARED_STYLE}
  body{ display:flex; flex-direction:column; overflow:hidden; }
  .header-left{ position:fixed; top:16px; left:22px; z-index:5; width:24px; height:24px; }
  .header-right{ position:fixed; top:13px; right:16px; z-index:5; display:flex; align-items:center; gap:2px; }
  .header-btn{ display:flex; align-items:center; gap:6px; background:transparent; border:none; cursor:pointer; color:var(--muted); font-size:12.5px; padding:9px 12px; border-radius:10px; transition:background .15s, color .15s; }
  .header-btn:hover{ background:var(--surface); color:var(--ink); }
  .scroll{ flex:1; overflow-y:auto; display:flex; justify-content:center; }
  .thread{ width:100%; max-width:640px; padding:70px 24px 20px; display:flex; flex-direction:column; gap:18px; }
  @keyframes rise{ from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:translateY(0);} }
  .row{ display:flex; animation:rise .28s ease; } .row.user{ justify-content:flex-start; } .row.agent{ justify-content:flex-start; }
  .bubble{ max-width:80%; padding:12px 16px; border-radius:16px; font-size:14.5px; line-height:1.68; white-space:pre-wrap; word-wrap:break-word; text-align:right; }
  .row.user .bubble{ background:var(--surface); color:var(--ink); border-bottom-left-radius:4px; }
  .row.agent .bubble{ background:var(--bg); color:var(--ink); border-bottom-right-radius:4px; width:100%; max-width:100%; border: 1px solid var(--border); }
  .system-note{ align-self:center; color:var(--muted); font-size:12px; text-align:center; max-width:85%; }
  .error-note{ align-self:flex-start; max-width:80%; font-size:13px; color:var(--danger); display:flex; align-items:flex-start; gap:8px; border-right:2px solid var(--danger); padding:9px 14px; background:var(--danger-bg); border-radius:10px; }
  .typing{ align-self:flex-start; display:flex; align-items:center; gap:8px; padding:12px 16px; background:var(--bg); border: 1px solid var(--border); border-radius:16px; border-bottom-right-radius:4px; font-size:13px; color:var(--muted); }
  .typing span{ width:6px; height:6px; border-radius:50%; background:var(--muted); animation:blink 1.3s infinite; }
  .typing span:nth-child(2){ animation-delay:.2s; } .typing span:nth-child(3){ animation-delay:.4s; }
  @keyframes blink{ 0%,80%,100%{opacity:.3} 40%{opacity:1} }
  .input-zone{ position:relative; display:flex; justify-content:center; padding:14px 24px 18px; }
  .composer{ position:relative; width:100%; max-width:640px; display:flex; align-items:flex-end; gap:10px; background:var(--surface); border-radius:22px; padding:8px 10px 8px 18px; }
  textarea{ flex:1; resize:none; border:none; background:transparent; outline:none; font-size:14.5px; color:var(--ink); max-height:120px; text-align:right; padding:9px 0; line-height:1.5; }
  .send-btn{ flex-shrink:0; width:38px; height:38px; border-radius:50%; background:var(--ink); color:#fff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; }
  .send-btn:disabled{ opacity:.25; cursor:not-allowed; }
</style></head><body>
  <div class="header-left">${LOGO_SVG}</div>
  <div class="header-right">
    <button class="header-btn" id="new-chat-btn"><i class="ti ti-message-plus"></i> مسح المحادثة</button>
    <button class="header-btn" id="logout-btn"><i class="ti ti-logout-2"></i> خروج</button>
  </div>
  <div class="scroll"><div class="thread" id="thread">
    <div class="system-note">تم تفعيل البنية الجديدة (Stateless Workflow). لا يوجد WebSockets.</div>
  </div></div>
  <div class="input-zone">
    <form class="composer" id="composer-form">
      textarea id="input" rows="1" placeholder="اكتب طلبك لـ Buffer..."></textarea>
      <button type="submit" class="send-btn" id="send-btn"><i class="ti ti-arrow-up"></i></button>
    </form>
  </div>

<script>
  let chatHistory = [];
  let mcpSessionId = null;
  let isProcessing = false;

  const thread = document.getElementById("thread");
  const scrollBox = document.querySelector(".scroll");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");

  function scrollDown() { scrollBox.scrollTop = scrollBox.scrollHeight; }

  function addBubble(text, kind) {
    const row = document.createElement("div"); row.className = "row " + kind;
    const bubble = document.createElement("div"); bubble.className = "bubble";
    bubble.textContent = text; row.appendChild(bubble); thread.appendChild(row); scrollDown();
  }
  
  function addError(text) {
    const div = document.createElement("div"); div.className = "error-note";
    div.innerHTML = '<i class="ti ti-alert-triangle"></i><span>' + text + '</span>';
    thread.appendChild(div); scrollDown();
  }

  let typingEl = null;
  function showTyping(statusText) {
    if (!typingEl) {
      typingEl = document.createElement("div"); typingEl.className = "typing";
      typingEl.innerHTML = '<div style="display:flex; gap:4px"><span></span><span></span><span></span></div><div class="status-text">جاري المعالجة (Workflow)...</div>';
      thread.appendChild(typingEl);
    } else if (statusText) {
      typingEl.querySelector(".status-text").textContent = statusText;
    }
    scrollDown();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  document.getElementById("composer-form").addEventListener("submit", async e => {
    e.preventDefault();
    if(isProcessing || !input.value.trim()) return;
    
    const text = input.value.trim();
    input.value = ""; input.style.height = "auto";
    addBubble(text, "user");
    
    chatHistory.push({ role: "user", parts: [{ text: text }] });
    isProcessing = true; sendBtn.disabled = true;
    showTyping();

    try {
      // 1. Start Workflow
      const startRes = await fetch("/api/chat/start", {
        method: "POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents: chatHistory, mcpSessionId: mcpSessionId })
      });
      const { workflowId, error } = await startRes.json();
      
      if(error) throw new Error(error);

      // 2. Poll Status
      let finalResult = null;
      while (true) {
        await new Promise(r => setTimeout(r, 2000)); // Poll every 2 seconds
        const statRes = await fetch("/api/chat/status?id=" + workflowId);
        const statusData = await statRes.json();
        
        if (statusData.status === "complete") {
          finalResult = statusData.output;
          break;
        } else if (statusData.status === "errored" || statusData.status === "terminated") {
          throw new Error("حدث خطأ داخل الـ Workflow: " + (statusData.error || statusData.status));
        } else {
          showTyping("الـ Agent شغال بيفكر وينفذ (Workflow step)...");
        }
      }

      // 3. Process Result
      hideTyping();
      if (finalResult.reply) addBubble(finalResult.reply, "agent");
      if (finalResult.newContents) chatHistory = finalResult.newContents;
      if (finalResult.mcpSessionId) mcpSessionId = finalResult.mcpSessionId;

    } catch (err) {
      hideTyping();
      addError(err.message || "حدث خطأ غير معروف");
    } finally {
      isProcessing = false; sendBtn.disabled = false; input.focus();
    }
  });

  document.getElementById("logout-btn").addEventListener("click", () => fetch("/api/logout", {method:"POST"}).then(()=>location.reload()));
  document.getElementById("new-chat-btn").addEventListener("click", () => location.reload());
</script></body></html>`;

// ---------------------------------------------------------------------------
// Cloudflare Workflow (The Engine) - Runs entirely independent of the request
// ---------------------------------------------------------------------------
// All logic, Gemini fetching, MCP fetching, ReAct looping is done here.
// This executes durably and is immune to short HTTP request timeouts.

export class AgentStepWorkflow extends WorkflowEntrypoint {
  
  async run(event, step) {
    let { contents, mcpSessionId } = event.payload;
    let mcpTools = [];
    
    const bufferKey = this.env.BUFFER_API_KEY;
    const geminiKey = this.env.GEMINI_API_KEY;

    if (!bufferKey || !geminiKey) {
      return { reply: "يجب ضبط مفاتيح BUFFER_API_KEY و GEMINI_API_KEY في إعدادات السيرفر.", newContents: contents };
    }

    // --- Helper function for MCP calls inside Workflow ---
    const callMcp = async (method, params, isNotif = false, sid = mcpSessionId) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + bufferKey };
      if (sid) headers["Mcp-Session-Id"] = sid;
      const body = { jsonrpc: "2.0", method: method, params: params || {} };
      if (!isNotif) body.id = crypto.randomUUID();
      
      const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
      const newSid = res.headers.get("Mcp-Session-Id") || sid;
      if (isNotif) { await res.text().catch(()=>{}); return { sessionId: newSid, result: null }; }
      
      const parsed = await res.json();
      if (!res.ok || (parsed && parsed.error)) throw new Error(parsed?.error?.message || `MCP HTTP ${res.status}`);
      return { sessionId: newSid, result: parsed.result };
    };

    // 1. Initialize MCP if needed
    if (!mcpSessionId) {
      const initRes = await step.do("init-mcp", async () => {
        const i = await callMcp("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cf-wf-agent", version: "2.0" } }, false, null);
        await callMcp("notifications/initialized", {}, true, i.sessionId);
        const l = await callMcp("tools/list", {}, false, i.sessionId);
        return { sessionId: i.sessionId, tools: l.result?.tools || [] };
      });
      mcpSessionId = initRes.sessionId;
      mcpTools = initRes.tools;
    } else {
      // Just fetch tools if we already have a session
      const toolsRes = await step.do("list-tools", async () => await callMcp("tools/list", {}, false, mcpSessionId));
      mcpTools = toolsRes.result?.tools || [];
    }

    const systemPrompt = this.buildSystemPrompt(mcpTools);
    const MAX_STEPS = 10; // Prevent infinite loops in Workflow

    // 2. The Agent Loop (ReAct)
    for (let i = 0; i < MAX_STEPS; i++) {
      
      // Step A: Call Gemini
      const geminiRes = await step.do(`gemini-call-${i}`, async () => {
        const res = await fetch(GEMINI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: contents }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Gemini Error");
        return data;
      });

      const candidate = geminiRes.candidates?.[0];
      const rawText = candidate?.content?.parts?.map(p => p.text || "").join("").trim();
      if (!rawText) return { reply: "لم أتمكن من الحصول على رد صالح من النموذج.", newContents: contents, mcpSessionId };
      
      contents.push({ role: "model", parts: [{ text: rawText }] });

      const parsed = this.parseAgentResponse(rawText);
      if (!parsed || !parsed.phase) {
        return { reply: rawText || "لم أتمكن من معالجة الرد.", newContents: contents, mcpSessionId };
      }

      // Step B: Handle the Phase
      if (parsed.phase === "plan" || parsed.phase === "reflect") {
        contents.push({ role: "user", parts: [{ text: "[SYSTEM] تم التسجيل. يرجى المتابعة بالإجراء (act) التالي." }] });
        continue;
      }

      if (parsed.phase === "final") {
        return { reply: parsed.text || "تم إنجاز المطلوب.", newContents: contents, mcpSessionId };
      }

      if (parsed.phase === "act") {
        const toolResult = await step.do(`mcp-call-${i}`, async () => {
          try {
            const tr = await callMcp("tools/call", { name: parsed.name, arguments: parsed.args || {} }, false, mcpSessionId);
            const blocks = tr.result?.content || [];
            const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
            return text || JSON.stringify(tr.result);
          } catch (e) {
            return "ERROR: " + (e.message || "Unknown tool error");
          }
        });
        
        contents.push({ role: "user", parts: [{ text: `[FUNCTION_RESULT name="${parsed.name}"]\n${toolResult}\n[/FUNCTION_RESULT]` }] });
        continue;
      }
    }

    return { reply: "عذراً، العملية تطلبت خطوات كثيرة وتم إيقافها لتجنب استهلاك الموارد. يرجى تبسيط الطلب.", newContents: contents, mcpSessionId };
  }

  buildSystemPrompt(mcpTools) {
    const toolLines = mcpTools.map(t => `- **${t.name}**: ${t.description || ""}\n  Parameters: ${JSON.stringify(t.inputSchema || {})}`).join("\n\n");
    return `You are an assistant managing a Buffer account. Reply in the user's language (Arabic/English).
You reason in JSON. One JSON object per turn. No other text.
1. {"phase": "plan", "thought": "...", "steps": ["..."]}
2. {"phase": "act", "thought": "...", "name": "tool_name", "args": {...}}
3. {"phase": "reflect", "thought": "...", "status": "on_track" | "revise"}
4. {"phase": "final", "text": "Your reply to user"}
Rules: Do NOT output anything outside the JSON object.
Available tools:
${toolLines}`;
  }

  parseAgentResponse(text) {
    let cleaned = text.trim();
    const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) cleaned = fenced[1].trim();
    try { return JSON.parse(cleaned); } catch (e) { return null; }
  }
}
