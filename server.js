import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   App
========================================================= */
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: "1mb" }));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(limiter);

/* =========================================================
   Supabase (HTTP)
========================================================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE no ambiente.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

/* =========================================================
   OpenAI
========================================================= */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* =========================================================
   WooCommerce REST (somente leitura)
   Variables:
   - WC_SITE (ex: https://tucanhome.com.br)
   - WC_KEY
   - WC_SECRET
========================================================= */
const WC_SITE   = process.env.WC_SITE;
const WC_KEY    = process.env.WC_KEY;
const WC_SECRET = process.env.WC_SECRET;
const wcEnabled = !!(WC_SITE && WC_KEY && WC_SECRET);

async function wcFetch(path, params = {}) {
  if (!wcEnabled) return [];
  const base = WC_SITE.replace(/\/$/, "");
  const url = new URL(base + "/wp-json/wc/v3" + path);

  // defaults de paginação
  const qp = { per_page: 8, status: "publish", ...params };
  Object.entries(qp).forEach(([k, v]) => url.searchParams.set(k, v));

  // 1) tenta com Basic Auth (HTTPS)
  const auth = "Basic " + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
  let r = await fetch(url.toString(), { headers: { Authorization: auth } });

  // 2) se der 400/401, tenta via query string (alguns hosts exigem isso)
  if (r.status === 400 || r.status === 401) {
    const urlQS = new URL(url.toString());
    urlQS.searchParams.set("consumer_key", WC_KEY);
    urlQS.searchParams.set("consumer_secret", WC_SECRET);
    r = await fetch(urlQS.toString());
  }

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`WooCommerce error: ${r.status} - ${txt}`);
  }
  return r.json();
}

/** Busca produtos por termo e mapeia para {id,name,price,image,url} */
async function searchProducts(term) {
  if (!term || term.length < 2 || !wcEnabled) return [];
  const raw = await wcFetch("/products", { search: term, orderby: "relevance", per_page: 8 });
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price_html || (p.price ? `R$ ${p.price}` : ""),
    image: (p.images && p.images[0] && p.images[0].src) || "",
    url: p.permalink,
  }));
}

/* =========================================================
   Helpers (sessão, mensagens, lead)
========================================================= */
async function ensureSession(ctx) {
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
  const { error } = await supabase
    .from("chat_sessions")
    .upsert(payload, { onConflict: "session_id" });
  if (error) console.error("ensureSession error:", error.message);
}

async function insertMessage(session_id, who, text, ts) {
  const payload = {
    session_id,
    ts: ts || new Date().toISOString(),
    who,
    text: (text || "").slice(0, 8000),
  };
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

/* =========================================================
   Nome do usuário (captura e salva)
========================================================= */
function capitalizeFirstName(s = "") {
  const name = s.trim().split(/\s+/)[0];
  if (!name) return "";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Tenta extrair o primeiro nome de frases tipo:
 * "meu nome é João", "me chamo Ana", "sou o Pedro", "eu sou a Carla"
 */
function extractFirstNameFromText(text = "") {
  const t = text.trim();
  const re = /(?:meu\s+nome\s+é|me\s+chamo|eu\s+sou|sou\s+o|sou\s+a)\s+([A-Za-zÀ-ÿ'´`-]+)/i;
  const m = t.match(re);
  if (m && m[1]) return capitalizeFirstName(m[1].replace(/[^A-Za-zÀ-ÿ'´`-]/g, ""));
  // fallback: se só mandou um nome curto numa mensagem curta
  if (/^[A-Za-zÀ-ÿ'´`-]{2,20}$/.test(t)) return capitalizeFirstName(t);
  return "";
}

async function saveNameIfPresent(messages = [], session_id) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const nm = extractFirstNameFromText(lastUser);
  if (!nm) return;
  try {
    await supabase.from("chat_sessions").update({ nome: nm }).eq("session_id", session_id);
  } catch (e) {
    console.error("saveName error:", e.message);
  }
}

/* =========================================================
   Intenção de produto (OpenAI + fallback regex)
========================================================= */
function fallbackProductTerms(text = "") {
  const t = text.toLowerCase();
  const buckets = [
    { re: /(pendente|pendentes)/, term: "pendente" },
    { re: /(lumin[aá]ria|luminárias?|spot|trilho|plafon)/, term: "luminária" },
    { re: /(abajur|abajures)/, term: "abajur" },
    { re: /(vaso|vasos)/, term: "vaso" },
    { re: /(tapete|tapetes)/, term: "tapete" },
    { re: /(quadro|quadros)/, term: "quadro" },
  ];
  const found = buckets.find((b) => b.re.test(t));
  return found ? { need: true, terms: found.term } : { need: false, terms: "" };
}

async function extractProductIntent(messages = []) {
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content || "";

  const sys = { role: "system", content: "Você classifica intenção de produto e responde APENAS JSON." };
  const usr = {
    role: "user",
    content: `
Texto: """${lastUser}"""
Responda ESTRITAMENTE em JSON:
{"need_products": boolean, "terms": "palavras simples para buscar no catálogo"}
Se não houver intenção de produto, use {"need_products": false, "terms": ""}.
    `.trim(),
  };

  try {
    const r = await client.responses.create({
      model: OPENAI_MODEL,
      input: [sys, usr],
    });
    const txt = r.output_text || r.output || "{}";
    const parsed = JSON.parse(txt);
    return { need: !!parsed.need_products, terms: parsed.terms || "" };
  } catch {
    return fallbackProductTerms(lastUser);
  }
}

/* =========================================================
   Rotas
========================================================= */
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
            attributes: {
              NOME: lead?.nome || "",
              WHATS: lead?.whats || "",
              ORIGEM: "Chat Tucan",
            },
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

/**
 * Chat principal
 * - Pede o nome no começo (prompt)
 * - Captura e salva o primeiro nome quando informado
 * - Responde com texto
 * - Se detectar intenção de produto, consulta WooCommerce e devolve products[]
 */
app.post("/api/chat", async (req, res) => {
  const { messages = [], ...ctx } = req.body || {};
  try {
    await ensureSession(ctx);

    const system = {
      role: "system",
      content:
        "Você é o consultor de interiores da Tucan Home. Fale em PT-BR, seja prático e amigável. " +
        "Se ainda não souber o nome do cliente, comece pedindo o primeiro nome de forma natural " +
        "(ex.: 'Antes de começarmos, como posso te chamar?'). " +
        "Depois que o nome aparecer na conversa, passe a chamar o cliente por esse nome de forma natural. " +
        "Sugira paletas e produtos da Tucan quando fizer sentido. Se sugerir produtos, explique o porquê da escolha.",
    };

    // 1) resposta do modelo
    const r = await client.responses.create({
      model: OPENAI_MODEL,
      input: [system, ...messages],
    });
    const out = r.output_text || "Desculpe, não consegui responder agora.";
    await insertMessage(ctx.session_id, "bot", out);

    // 2) tenta capturar e salvar o nome
    await saveNameIfPresent(messages, ctx.session_id);

    // 3) intenção de produto + busca
    let products = [];
    try {
      const intent = await extractProductIntent(messages);
      if (intent.need && intent.terms) {
        products = await searchProducts(intent.terms);
      }
    } catch (e) {
      console.error("intent/products error:", e.message);
    }

    res.json({ output_text: out, products });
  } catch (e) {
    console.error("chat error:", e.message);
    res
      .status(200)
      .json({
        output_text:
          "Estou em manutenção no momento. Tente novamente em instantes 🙏",
        products: [],
      });
  }
});

/**
 * Endpoint utilitário para testar a busca de produtos manualmente:
 * GET /api/products?search=pendente
 */
app.get("/api/products", async (req, res) => {
  const q = (req.query.search || "").toString();
  try {
    const items = await searchProducts(q);
    res.json({ products: items });
  } catch (e) {
    res.status(500).json({ error: e.message, products: [] });
  }
});

// raiz opcional
app.get("/", (_, res) => {
  res.send("Tucan Chat API rodando. Use /api/health para status.");
});

/* =========================================================
   Start
========================================================= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tucan Chat API on :" + port));