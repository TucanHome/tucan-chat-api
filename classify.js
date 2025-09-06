
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function db(q,p=[]) { return pool.query(q,p); }

const ROOM = [["sala",/\bsala(s)?\b/i],["quarto",/\bquarto(s)?\b/i],["cozinha",/\bcozinha(s)?\b/i],["banheiro",/\bbanheiro(s)?\b/i],["varanda",/\bvaranda(s)?\b/i],["home office",/\b(home ?office|escrit[oó]rio)\b/i]];
const PRODUCT = [["vaso",/\bvaso(s)?\b/i],["abajur",/\babajur(es)?\b/i],["pendente",/\bpendente(s)?\b/i],["arandela",/\barandela(s)?\b/i],["lumin[aá]ria",/\blumin[aá]ria(s)?\b/i]];
const STYLE = [["minimalista",/\bminimal(ista|ismo)\b/i],["escandinavo",/\bescandin(av|avo)\b/i],["industrial",/\bindustrial\b/i],["r[uú]stico",/\br[uú]stic[oa]\b/i],["moderno",/\bmoderno\b/i],["boho",/\bboho\b/i]];
const COLOR = [["bege",/\bbege\b/i],["cinza",/\bcinza\b/i],["preto",/\bpreto\b/i],["branco",/\bbranco\b/i],["terracota",/\bterracota\b/i],["madeira",/\bmadeira\b/i]];
const INTENT = [["orçamento",/\bor[cç]a?ment(o|a)\b/i],["compra",/\bcompr(ar|a|ando|aria)\b/i],["descoberta",/\bideia(s)?|inspira(c|ç)[aã]o|dica(s)?\b/i]];

function match(dict, txt){ for(const [k,rx] of dict) if(rx.test(txt)) return k; return null; }

(async ()=>{
  const { rows } = await db(`
    SELECT m.id, m.text, m.ts::date AS day
    FROM chat_messages m
    LEFT JOIN chat_message_tags t ON t.message_id = m.id
    WHERE m.who='user' AND t.message_id IS NULL
    ORDER BY m.id ASC
    LIMIT 500
  `);

  for(const r of rows){
    const t = r.text || "";
    const room   = match(ROOM, t);
    const product= match(PRODUCT, t);
    const style  = match(STYLE, t);
    const color  = match(COLOR, t);
    const intent = match(INTENT, t);
    const has_doubt = /(\?|duv[ií]da|como|qual|quanto|pode|devo|ser[aá])\b/i.test(t);

    await db(`
      INSERT INTO chat_message_tags (message_id, room, product, style, color, intent, has_doubt)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (message_id) DO NOTHING
    `,[r.id, room, product, style, color, intent, has_doubt]);

    const date = r.day;
    for(const [cat, val] of [["room",room],["product",product],["style",style],["color",color],["intent",intent]]){
      if(!val) continue;
      await db(`
        INSERT INTO chat_metrics_daily (date, category, item, count)
        VALUES ($1,$2,$3,1)
        ON CONFLICT (date, category, item) DO UPDATE SET count = chat_metrics_daily.count + 1
      `,[date, cat, val]);
    }
  }
  console.log("OK classify:", rows.length);
  process.exit(0);
})().catch(e=>{ console.error(e); process.exit(1); });
