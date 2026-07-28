-- Contact suggestions (address-book cache). Scoped to (company, mailbox account).
CREATE TABLE public.mail_contact_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  mailbox_account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  display_name text,
  frequency integer NOT NULL DEFAULT 1,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'sent',
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_contact_suggestions_uniq UNIQUE (company_id, mailbox_account_id, email_normalized),
  CONSTRAINT mail_contact_suggestions_email_chk CHECK (email_normalized = lower(email_normalized) AND length(email_normalized) BETWEEN 3 AND 320),
  CONSTRAINT mail_contact_suggestions_source_chk CHECK (source IN ('sent','manual','imported'))
);

CREATE INDEX mail_contact_suggestions_scope_idx
  ON public.mail_contact_suggestions (company_id, mailbox_account_id, hidden_at, last_used_at DESC);

-- No direct access from anon/authenticated. All I/O via server functions using service_role.
GRANT ALL ON public.mail_contact_suggestions TO service_role;
ALTER TABLE public.mail_contact_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mail_contact_suggestions_deny_all"
  ON public.mail_contact_suggestions FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- updated_at trigger
CREATE TRIGGER mail_contact_suggestions_set_updated_at
  BEFORE UPDATE ON public.mail_contact_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomic batch upsert. Server-only (private schema, no anon/authenticated EXECUTE).
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.record_mail_contact_suggestions(
  p_company_id uuid,
  p_account_id uuid,
  p_items jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'company_id and account_id required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'too many items';
  END IF;

  WITH raw AS (
    SELECT
      lower(btrim(x->>'email')) AS email_normalized,
      NULLIF(btrim(x->>'name'), '') AS display_name
    FROM jsonb_array_elements(p_items) x
  ),
  filtered AS (
    SELECT email_normalized, display_name
    FROM raw
    WHERE email_normalized IS NOT NULL
      AND length(email_normalized) BETWEEN 3 AND 320
      AND email_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  deduped AS (
    -- Collapse duplicates in the input so ON CONFLICT never fires twice per row.
    SELECT DISTINCT ON (email_normalized)
      email_normalized, display_name
    FROM filtered
    ORDER BY email_normalized, display_name NULLS LAST
  ),
  ins AS (
    INSERT INTO public.mail_contact_suggestions
      (company_id, mailbox_account_id, email_normalized, display_name, source, last_used_at)
    SELECT p_company_id, p_account_id, d.email_normalized, d.display_name, 'sent', v_now
    FROM deduped d
    ON CONFLICT (company_id, mailbox_account_id, email_normalized) DO UPDATE
      SET frequency    = public.mail_contact_suggestions.frequency + 1,
          last_used_at = EXCLUDED.last_used_at,
          display_name = CASE
            WHEN EXCLUDED.display_name IS NOT NULL THEN EXCLUDED.display_name
            ELSE public.mail_contact_suggestions.display_name
          END,
          hidden_at    = NULL,
          updated_at   = v_now
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.record_mail_contact_suggestions(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.record_mail_contact_suggestions(uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_mail_contact_suggestions(uuid, uuid, jsonb) TO service_role;