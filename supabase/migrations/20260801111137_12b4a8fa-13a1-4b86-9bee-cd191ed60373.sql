CREATE TABLE public.mail_account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  linked_account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_account_links_not_self CHECK (owner_account_id <> linked_account_id),
  CONSTRAINT mail_account_links_unique UNIQUE (owner_account_id, linked_account_id)
);

CREATE INDEX mail_account_links_owner_idx ON public.mail_account_links (owner_account_id);
CREATE INDEX mail_account_links_company_idx ON public.mail_account_links (company_id);

GRANT ALL ON public.mail_account_links TO service_role;

ALTER TABLE public.mail_account_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_account_links_deny_all ON public.mail_account_links
  AS PERMISSIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_account_links_set_updated_at
  BEFORE UPDATE ON public.mail_account_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();