
TUCAN CHAT API — PASSO A PASSO

1) BANCO (SUPABASE/NEON)
   - Crie um Postgres gratuito.
   - Abra o SQL Editor e rode o arquivo schema.sql para criar as tabelas.
   - Copie a CONNECTION STRING (DATABASE_URL).

2) BACKEND (RENDER/RAILWAY/VERCEL)
   - Suba estes arquivos para um repositório no GitHub (ou faça upload direto se a plataforma permitir).
   - Crie um Web Service Node.js.
   - Build: npm install
   - Start: npm start
   - Variáveis de ambiente:
       OPENAI_API_KEY= SUA_CHAVE_DA_OPENAI
       DATABASE_URL= SUA_CONNECTION_STRING_DO_POSTGRES
       BREVO_API_KEY= SUA_CHAVE_V3_DO_BREVO (opcional, mas recomendado)
   - Após deploy, teste: https://SEU_DOMINIO/api/health  ->  {"ok":true}

3) FRONTEND (PÁGINA DO WORDPRESS)
   - Crie a página /consultor-tucan.
   - Cole o snippet do chat (HTML+CSS+JS) e troque API_BASE pela URL do backend.
   - Abra a página e teste: envie 2-3 mensagens, veja o formulário de lead aparecer.

4) BREVO
   - Em /api/lead, já há integração (listIds: [6]).
   - Ajuste o ID da sua lista se necessário.
   - No Brevo, crie atributos customizados (NOME, WHATS, ORIGEM).

5) CLASSIFICAÇÃO (OPCIONAL)
   - Rode: npm run classify
   - Crie um cron (Render/Railway) para executar 1x/dia.
   - Veja resultados em chat_metrics_daily.

DICAS
   - Nunca exponha chaves no frontend (site).
   - Se algo der erro, cheque os logs do serviço (Render Logs).
