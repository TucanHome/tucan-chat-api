
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  page TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  started_at TIMESTAMP,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  ts TIMESTAMP,
  who TEXT CHECK (who IN ('user','bot')),
  text TEXT
);

CREATE TABLE IF NOT EXISTS chat_leads (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  nome TEXT,
  whats TEXT,
  lgpd_optin BOOLEAN,
  created_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_message_tags (
  message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE,
  room TEXT,
  product TEXT,
  style TEXT,
  color TEXT,
  intent TEXT,
  has_doubt BOOLEAN DEFAULT NULL,
  PRIMARY KEY (message_id)
);

CREATE TABLE IF NOT EXISTS chat_metrics_daily (
  date DATE,
  category TEXT,
  item TEXT,
  count INTEGER,
  PRIMARY KEY (date, category, item)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ts ON chat_messages(session_id, ts);
