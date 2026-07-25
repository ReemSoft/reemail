
-- Domain-level email settings
CREATE TABLE public.email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  imap_host TEXT NOT NULL,
  imap_port INT NOT NULL DEFAULT 993,
  imap_secure BOOLEAN NOT NULL DEFAULT true,
  smtp_host TEXT NOT NULL,
  smtp_port INT NOT NULL DEFAULT 465,
  smtp_secure BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_domains_company_id_idx ON public.email_domains(company_id);
CREATE INDEX email_domains_domain_lower_idx ON public.email_domains(lower(domain));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_domains TO authenticated;
GRANT ALL ON public.email_domains TO service_role;

ALTER TABLE public.email_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins manage own domains" ON public.email_domains
  FOR ALL TO authenticated
  USING (private.is_company_admin(auth.uid(), company_id))
  WITH CHECK (private.is_company_admin(auth.uid(), company_id));

CREATE POLICY "Super admins full domains" ON public.email_domains
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (private.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE TRIGGER set_email_domains_updated_at
  BEFORE UPDATE ON public.email_domains
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Make per-account server fields optional (used only as overrides)
ALTER TABLE public.mail_accounts
  ALTER COLUMN imap_host DROP NOT NULL,
  ALTER COLUMN imap_port DROP NOT NULL,
  ALTER COLUMN imap_secure DROP NOT NULL,
  ALTER COLUMN smtp_host DROP NOT NULL,
  ALTER COLUMN smtp_port DROP NOT NULL,
  ALTER COLUMN smtp_secure DROP NOT NULL;
