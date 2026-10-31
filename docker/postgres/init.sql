SET password_encryption = 'md5';

CREATE ROLE demo LOGIN PASSWORD 'demo';
GRANT CONNECT ON DATABASE app TO demo;
GRANT USAGE, CREATE ON SCHEMA public TO demo;

CREATE TABLE IF NOT EXISTS items (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE items OWNER TO demo;
INSERT INTO items (name) SELECT 'item-' || g FROM generate_series(1, 10000) g;
