import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ============ App ============
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: "1mb" }));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(limiter);

// ============ Supabase (HTTP) ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE no ambiente.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ============ OpenAI ============
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============ Helpers ============
async function ensureSession(ctx) {
  // upsert da sessão
  const payload = {
    session_id: ctx.session_id,
    page: ctx.page || null,
    utm_source: ctx?.utm?.source || null,
    utm_medium: ctx?.utm?.medium || null,
    utm_campaign: ctx?.utm?.campaign || null,
    utm_content: ctx?.utm?.content || null,
    utm_term: ctx?.utm?.term || null,
    started_at: ctx.started_at || new Date().toISOString(),
    user_agent: ctx.user_agent || null,
  };
  const { error } = await supabase.from("chat_sessions").upsert(payload, { onConflict: "session_id" });
  if (error) console.error("ensureSession error:", error.message);
}

async function insertMessage(session_id, who, text, ts) {
  const payload = { session_id, ts: ts || new Date().toISOString(), who, text: (text || "").slice(0, 8000) };
  const { error } = await supabase.from("chat_messages").insert(payload);
  if (error) console.error("insertMessage error:", error.message);
}

async function insertLead(session_id, lead) {
  const payload = {
    session_id,
    nome: (lead?.nome || "").slice(0, 120),
    whats: (lead?.whats || "").slice(0, 60),
    lgpd_optin: !!lead?.lgpd_optin,
  };
  const { error } = await supabase
    .from("chat_leads")
    .upsert(payload, { onConflict: "session_id" });
  if (error) console.error("insertLead error:", error.message);
}

// ============ Rotas ============
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/log", async (req, res) => {
  try {
    const { kind, ts, data, ...ctx } = req.body || {};
    if (!ctx?.session_id) return res.json({ ok: true });

    await ensureSession(ctx);
    if (kind === "message") {
      const who = data?.who === "user" ? "user" : "bot";
      await insertMessage(ctx.session_id, who, data?.text || "", ts);
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.post("/api/lead", async (req, res) => {
  const { lead, ...ctx } = req.body || {};
  try {
    await ensureSession(ctx);
    await insertLead(ctx.session_id, lead);

    // Brevo (opcional)
    try {
      if (process.env.BREVO_API_KEY) {
        await fetch("https://api.brevo.com/v3/contacts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": process.env.BREVO_API_KEY,
          },
          body: JSON.stringify({
            attributes: { NOME: lead?.nome || "", WHATS: lead?.whats || "", ORIGEM: "Chat Tucan" },
            updateEnabled: true,
            listIds: [6],
          }),
        });
      }
    } catch (e) {
      console.error("Brevo error:", e.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("lead error:", e.message);
    res.status(200).json({ ok: true }); // nunca derruba o chat por causa do lead
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages = [], ...ctx } = req.body || {};
  try {
    await ensureSession(ctx);

    const system = {
      role: "system",
      content:
        "Você é o consultor de interiores da Tucan Home. Fale em PT-BR, seja prático. " +
        "Sugira paletas e produtos da Tucan quando fizer sentido.",
    };

    const r = await client.responses.create({
      model: "gpt-4o-mini",
      input: [system, ...messages],
    });

    const out = r.output_text || "Desculpe, não consegui responder agora.";
    await insertMessage(ctx.session_id, "bot", out);
    res.json({ output_text: out });
  } catch (e) {
    console.error("chat error:", e.message);
    res.status(200).json({ output_text: "Estou em manutenção no momento. Tente novamente em instantes 🙏" });
  }
});

// raiz opcional
app.get("/", (_, res) => {
  res.send("Tucan Chat API rodando. Use /api/health para status.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tucan Chat API on :" + port));