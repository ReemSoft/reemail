-- MAILMAESTRO_WORKING_DRAFT_SENDS
--
-- Durable send-attempt idempotency for Draft-origin Send. A logical Working
-- Draft may be SMTP-sent exactly once. This table intentionally has no FK to
-- mail_working_drafts: the send-attempt row must survive the Draft row being
-- deleted after a successful SMTP acceptance and provider cleanup.

CREATE TABLE IF NOT EXISTS public.mail_working_draft_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'sending', 'sent', 'failed')),
  smtp_result jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_working_draft_sends_draft_tenant_unique
    UNIQUE (draft_id, company_id, account_id),
  CONSTRAINT mail_working_draft_sends_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts(id, company_id) ON DELETE CASCADE
);

ALTER TABLE public.mail_working_draft_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_working_draft_sends FROM anon, authenticated;
GRANT ALL ON public.mail_working_draft_sends TO service_role;

DROP POLICY IF EXISTS "mail_working_draft_sends_no_direct_client_access"
  ON public.mail_working_draft_sends;
CREATE POLICY "mail_working_draft_sends_no_direct_client_access"
  ON public.mail_working_draft_sends AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid
)
RETURNS TABLE(claimed boolean, state text, smtp_result jsonb, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.mail_working_draft_sends%ROWTYPE;
  inserted_id uuid;
BEGIN
  INSERT INTO public.mail_working_draft_sends (
    draft_id, company_id, account_id, state, lease_until
  ) VALUES (
    p_draft_id, p_company_id, p_account_id, 'preparing', now() + interval '10 minutes'
  )
  ON CONFLICT (draft_id, company_id, account_id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO current_row
  FROM public.mail_working_draft_sends
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF current_row.state = 'sent' THEN
    RETURN QUERY SELECT false, current_row.state, current_row.smtp_result, current_row.error;
    RETURN;
  END IF;

  IF current_row.state = 'failed' THEN
    UPDATE public.mail_working_draft_sends
    SET state = 'preparing',
        error = NULL,
        smtp_result = NULL,
        lease_until = now() + interval '10 minutes',
        updated_at = now()
    WHERE id = current_row.id;
    RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  IF current_row.state = 'preparing' THEN
    IF current_row.lease_until IS NULL OR current_row.lease_until < now() THEN
      UPDATE public.mail_working_draft_sends
      SET lease_until = now() + interval '10 minutes',
          updated_at = now()
      WHERE id = current_row.id;
      RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT false, current_row.state, current_row.smtp_result, current_row.error;
    RETURN;
  END IF;

  -- state = 'sending' means SMTP is in-flight or its outcome is ambiguous.
  -- Never automatically reclaim or resend this state.
  RETURN QUERY SELECT false, current_row.state, current_row.smtp_result, current_row.error;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_in_flight(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_id uuid;
BEGIN
  UPDATE public.mail_working_draft_sends
  SET state = 'sending',
      lease_until = NULL,
      updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
    AND state = 'preparing'
  RETURNING id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_working_draft_send_in_flight(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_working_draft_send_in_flight(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_sent(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.mail_working_draft_sends
  SET state = 'sent',
      smtp_result = p_result,
      error = NULL,
      lease_until = NULL,
      updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
    AND state = 'sending';
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_working_draft_send_sent(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_working_draft_send_sent(uuid, uuid, uuid, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_failed(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.mail_working_draft_sends
  SET state = 'failed',
      error = left(coalesce(p_error, 'SEND_FAILED'), 120),
      smtp_result = NULL,
      lease_until = NULL,
      updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
    AND state IN ('preparing', 'sending');
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_working_draft_send_failed(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_working_draft_send_failed(uuid, uuid, uuid, text)
  TO service_role;
