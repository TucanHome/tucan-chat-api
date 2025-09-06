
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { Pool } from "pg";
import { z } from "zod";

// ====== App ======
const app = express();
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: "1mb" }));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(limiter);

// ====== DB ======
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function db(q, p = []) { return pool.query(q, p); }

// ====== OpenAI ======
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Validate ctx ======
const CtxSchema = z.object({
  session_id: z.string().min(6),
  page: z.string(),
  utm: z.object({
    source: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    campaign: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    term: z.string().nullable().optional()
  }).optional(),
  started_at: z.string().optional(),
  user_agent: z.string().optional()
});

async function ensureSession(ctx) {
  const c = CtxSchema.parse(ctx);
  await db(
    `INSERT INTO chat_sessions 
     (session_id, page, utm_source, utm_medium, utm_campaign, utm_content, utm_term, started_at, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      c.session_id, c.page, c.utm?.source || null, c.utm?.medium || null, c.utm?.campaign || null,
      c.utm?.content || null, c.utm?.term || null, c.started_at || new Date().toISOString(), c.user_agent || null
    ]
  );
}

// ====== Routes ======
app.get("/api/health", (_, res) => res.json({ ok: true }));

// Log message/event
app.post("/api/log", async (req, res) => {
  const { kind, ts, data, ...ctx } = req.body;
  await ensureSession(ctx);
  if (kind === "message") {
    const who = data?.who === "user" ? "user" : "bot";
    const text = (data?.text || "").toString().slice(0, 8000);
    await db(`INSERT INTO chat_messages (session_id, ts, who, text) VALUES ($1,$2,$3,$4)`,
      [ctx.session_id, ts || new Date().toISOString(), who, text]);
  }
  res.json({ ok: true });
});

// Lead capture (+ Brevo)
app.post("/api/lead", async (req, res) => {
  const { lead, ...ctx } = req.body;
  await ensureSession(ctx);
  const nome  = (lead?.nome  || "").toString().slice(0, 120);
  const whats = (lead?.whats || "").toString().slice(0, 60);
  const optin = !!lead?.lgpd_optin;

  // Save locally
  await db(
    `INSERT INTO chat_leads (session_id, nome, whats, lgpd_optin, created_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (session_id) DO UPDATE 
       SET nome=EXCLUDED.nome, whats=EXCLUDED.whats, lgpd_optin=EXCLUDED.lgpd_optin`,
    [ctx.session_id, nome, whats, optin]
  );

  // Send to Brevo
  try {
    if (process.env.BREVO_API_KEY) {
      const resp = await fetch("https://api.brevo.com/v3/contacts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          attributes: { NOME: nome, WHATS: whats, ORIGEM: "Chat Tucan" },
          updateEnabled: true,
          listIds: [6] // <-- troque se desejar
        })
      });
      await resp.json(); // ignore body, just to flush
    }
  } catch (e) {
    console.error("Brevo error:", e.message);
  }

  res.json({ ok: true });
});

// Chat
app.post("/api/chat", async (req, res) => {
  const { messages = [], ...ctx } = req.body;
  await ensureSession(ctx);

  const system = {
    role: "system",
    content:
      "Você é o consultor de interiores da Tucan Home. Fale em PT-BR. " +
      "Não recomende madeira/metal nem luz ajustável; prefira plástico/gesso. " +
      "Sugira produtos Tucan quando fizer sentido. Seja prático, com medidas e paletas."
  };

  try {
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      input: [system, ...messages]
    });
    const out = r.output_text || "Desculpe, não consegui responder agora.";

    await db(
      `INSERT INTO chat_messages (session_id, ts, who, text) VALUES ($1,NOW(),'bot',$2)`,
      [ctx.session_id, out.slice(0,8000)]
    );
    res.json({ output_text: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao gerar resposta." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tucan Chat API on :" + port));
