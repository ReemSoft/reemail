CREATE TABLE public.mail_message_body_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  canonical text NOT NULL,
  uid bigint NOT NULL,
  uid_validity bigint NOT NULL,
  cache_version integer NOT NULL DEFAULT 1,
  body_html text,
  body_text text,
  preview text,
  inline_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  byte_size integer NOT NULL DEFAULT 0,
  oversize boolean NOT NULL DEFAULT false,
  cached_at timestamp with time zone NOT NULL DEFAULT now(),
  last_accessed_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_body_cache_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id) ON DELETE CASCADE,
  CONSTRAINT mail_message_body_cache_unique
    UNIQUE (company_id, account_id, canonical, uid, uid_validity)
);

CREATE INDEX mail_message_body_cache_lru_idx
  ON public.mail_message_body_cache (account_id, last_accessed_at);
CREATE INDEX mail_message_body_cache_age_idx
  ON public.mail_message_body_cache (cached_at);

GRANT ALL ON public.mail_message_body_cache TO service_role;

ALTER TABLE public.mail_message_body_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_message_body_cache_deny_all
  ON public.mail_message_body_cache
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE TRIGGER mail_message_body_cache_set_updated_at
  BEFORE UPDATE ON public.mail_message_body_cache
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();