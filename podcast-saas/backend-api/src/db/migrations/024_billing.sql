-- Pay-to-unlock billing: lockable videos/playlists + transactions + purchases.

-- Pricing on projects (videos) and playlists
ALTER TABLE projects
  ADD COLUMN access_type TEXT    NOT NULL DEFAULT 'free',   -- 'free' | 'paid'
  ADD COLUMN price_cents INTEGER,
  ADD COLUMN currency    TEXT    NOT NULL DEFAULT 'usd';

ALTER TABLE playlists
  ADD COLUMN access_type TEXT    NOT NULL DEFAULT 'free',
  ADD COLUMN price_cents INTEGER,
  ADD COLUMN currency    TEXT    NOT NULL DEFAULT 'usd';

-- Stripe customer per user
ALTER TABLE users
  ADD COLUMN stripe_customer_id TEXT;

-- Every charge attempt (one Stripe Checkout session)
CREATE TABLE billing_transactions (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_checkout_session_id  TEXT,
  stripe_payment_intent_id    TEXT,
  type                        TEXT        NOT NULL DEFAULT 'charge',
  status                      TEXT        NOT NULL DEFAULT 'pending',
  amount_cents                INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  platform_fee_cents          INTEGER     NOT NULL DEFAULT 0,
  creator_payout_cents        INTEGER     NOT NULL DEFAULT 0,
  payer_user_id               UUID        REFERENCES users(id) ON DELETE SET NULL,
  payer_email                 TEXT,
  creator_user_id             UUID        REFERENCES users(id) ON DELETE SET NULL,
  content_type                TEXT        NOT NULL,         -- 'project' | 'playlist'
  content_id                  UUID        NOT NULL,
  description                 TEXT,
  error                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                TIMESTAMPTZ
);
CREATE INDEX idx_billing_tx_payer   ON billing_transactions(payer_user_id);
CREATE INDEX idx_billing_tx_creator ON billing_transactions(creator_user_id);
CREATE INDEX idx_billing_tx_session ON billing_transactions(stripe_checkout_session_id);

-- Persistent record of what a user owns
CREATE TABLE user_purchases (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type   TEXT        NOT NULL,                      -- 'project' | 'playlist'
  content_id     UUID        NOT NULL,
  transaction_id UUID        REFERENCES billing_transactions(id) ON DELETE SET NULL,
  amount_cents   INTEGER     NOT NULL,
  currency       TEXT        NOT NULL DEFAULT 'usd',
  purchased_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_type, content_id)
);
CREATE INDEX idx_user_purchases_content ON user_purchases(content_type, content_id);
