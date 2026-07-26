-- =========================================================
-- Phase 1: Local Mail Index — schema only
-- =========================================================

-- 1) mail_accounts: normalized_email (STORED generated) + unique
ALTER TABLE public.mail_accounts
  ADD COLUMN normalized_email text
    GENERATED ALWAYS AS (lower(btrim(email_address))) STORED;

ALTER TABLE public.mail_accounts
  ADD CONSTRAINT mail_accounts_normalized_email_key UNIQUE (normalized_email);

-- Composite unique needed as FK target for child tables (company isolation)
ALTER TABLE public.mail_accounts
  ADD CONSTRAINT mail_accounts_id_company_key UNIQUE (id, company_id);

-- 2) email_domains: composite unique so source_domain FK stays within same company
ALTER TABLE public.email_domains
  ADD CONSTRAINT email_domains_id_company_key UNIQUE (id, company_id);

-- 3) source_domain_id on mail_accounts — composite FK, RESTRICT on delete
ALTER TABLE public.mail_accounts
  ADD COLUMN source_domain_id uuid NULL;

ALTER TABLE public.mail_accounts
  ADD CONSTRAINT mail_accounts_source_domain_fkey
    FOREIGN KEY (source_domain_id, company_id)
    REFERENCES public.email_domains (id, company_id)
    ON DELETE RESTRICT;

CREATE INDEX mail_accounts_source_domain_idx
  ON public.mail_accounts(source_domain_id)
  WHERE source_domain_id IS NOT NULL;

-- =========================================================
-- 4) mail_folders
-- =========================================================
CREATE TABLE public.mail_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  company_id uuid NOT NULL,
  canonical text NOT NULL,
  path text NOT NULL,
  delimiter text,
  uidvalidity bigint,
  total integer NOT NULL DEFAULT 0,
  unread integer NOT NULL DEFAULT 0,
  supported boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_folders_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_folders_account_path_key UNIQUE (account_id, path),
  CONSTRAINT mail_folders_id_company_key UNIQUE (id, company_id)
);

GRANT ALL ON public.mail_folders TO service_role;

ALTER TABLE public.mail_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_folders_deny_all"
  ON public.mail_folders FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_folders_set_updated_at
  BEFORE UPDATE ON public.mail_folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX mail_folders_account_idx ON public.mail_folders(account_id);
CREATE INDEX mail_folders_company_idx ON public.mail_folders(company_id);

-- =========================================================
-- 5) mail_messages
-- =========================================================
CREATE TABLE public.mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  company_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  uid bigint NOT NULL,
  uidvalidity bigint NOT NULL,
  message_id text,
  thread_id text,
  subject text,
  from_addr jsonb,
  to_addrs jsonb,
  cc_addrs jsonb,
  preview text,
  internal_date timestamptz,
  flags text[] NOT NULL DEFAULT '{}',
  seen boolean NOT NULL DEFAULT false,
  flagged boolean NOT NULL DEFAULT false,
  has_attachments boolean NOT NULL DEFAULT false,
  size_bytes integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_messages_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_messages_folder_company_fkey
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_messages_folder_uid_key UNIQUE (folder_id, uidvalidity, uid)
);

GRANT ALL ON public.mail_messages TO service_role;

ALTER TABLE public.mail_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_messages_deny_all"
  ON public.mail_messages FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_messages_set_updated_at
  BEFORE UPDATE ON public.mail_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX mail_messages_folder_date_idx
  ON public.mail_messages(folder_id, internal_date DESC NULLS LAST);
CREATE INDEX mail_messages_account_idx ON public.mail_messages(account_id);
CREATE INDEX mail_messages_company_idx ON public.mail_messages(company_id);
CREATE INDEX mail_messages_thread_idx
  ON public.mail_messages(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX mail_messages_unread_idx
  ON public.mail_messages(folder_id) WHERE seen = false;

-- =========================================================
-- 6) mail_sync_state
-- =========================================================
CREATE TABLE public.mail_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  company_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  last_synced_uid bigint,
  last_synced_at timestamptz,
  last_full_sync_at timestamptz,
  sync_in_progress boolean NOT NULL DEFAULT false,
  sync_lock_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_sync_state_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_sync_state_folder_company_fkey
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_sync_state_folder_key UNIQUE (folder_id)
);

GRANT ALL ON public.mail_sync_state TO service_role;

ALTER TABLE public.mail_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_sync_state_deny_all"
  ON public.mail_sync_state FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_sync_state_set_updated_at
  BEFORE UPDATE ON public.mail_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX mail_sync_state_account_idx ON public.mail_sync_state(account_id);
CREATE INDEX mail_sync_state_company_idx ON public.mail_sync_state(company_id);