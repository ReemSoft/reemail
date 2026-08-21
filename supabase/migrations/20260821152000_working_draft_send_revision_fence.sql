-- MAILMAESTRO_WORKING_DRAFT_SEND_REVISION_FENCE
--
-- Bind a logical Draft Send to the exact Working Draft revision approved by the
-- browser. This reuses the existing per-Draft advisory lock, so it adds no
-- polling, background work, or read-path queries.

CREATE OR REPLACE FUNCTION public.save_mail_working_draft(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_expected_revision bigint,
  p_payload jsonb
)
RETURNS TABLE(revision bigint, conflict boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.mail_working_drafts%ROWTYPE;
  current_send_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    RAISE EXCEPTION 'DRAFT_DISCARDED' USING ERRCODE = '23514';
  END IF;

  IF p_expected_revision < 0 OR p_payload IS NULL THEN
    RAISE EXCEPTION 'invalid working draft mutation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_row
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
  FOR UPDATE;

  SELECT state INTO current_send_state
  FROM public.mail_working_draft_sends
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF current_send_state IN ('preparing', 'sending', 'sent') THEN
    RETURN QUERY SELECT COALESCE(current_row.revision, 0)::bigint, true;
    RETURN;
  END IF;

  IF current_row.id IS NULL THEN
    IF p_expected_revision <> 0 THEN
      RETURN QUERY SELECT 0::bigint, true;
      RETURN;
    END IF;

    INSERT INTO public.mail_working_drafts (
      id, company_id, account_id, payload, revision,
      remote_checkpoint_state, remote_checkpoint_revision
    ) VALUES (
      p_draft_id, p_company_id, p_account_id, p_payload, 1,
      'pending', 0
    );
    RETURN QUERY SELECT 1::bigint, false;
    RETURN;
  END IF;

  IF current_row.company_id <> p_company_id OR current_row.account_id <> p_account_id THEN
    RAISE EXCEPTION 'working draft ownership mismatch' USING ERRCODE = '42501';
  END IF;

  IF current_row.revision <> p_expected_revision THEN
    RETURN QUERY SELECT current_row.revision, true;
    RETURN;
  END IF;

  UPDATE public.mail_working_drafts
  SET payload = p_payload,
      revision = current_row.revision + 1,
      remote_checkpoint_state = CASE
        WHEN current_row.remote_checkpoint_state = 'running'
          AND current_row.remote_checkpoint_lease_until IS NOT NULL
          AND current_row.remote_checkpoint_lease_until >= now()
        THEN 'running'
        ELSE 'pending'
      END,
      remote_checkpoint_error = NULL,
      updated_at = now()
  WHERE id = p_draft_id;

  RETURN QUERY SELECT current_row.revision + 1, false;
END;
$$;

REVOKE ALL ON FUNCTION public.save_mail_working_draft(uuid, uuid, uuid, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_mail_working_draft(uuid, uuid, uuid, bigint, jsonb)
  TO service_role;

-- Fail closed for stale application instances that still call the legacy
-- three-argument claim after this migration is applied.
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
BEGIN
  RETURN QUERY
    SELECT false, 'failed'::text, NULL::jsonb, 'EXPECTED_REVISION_REQUIRED'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_expected_revision bigint
)
RETURNS TABLE(claimed boolean, state text, smtp_result jsonb, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_send public.mail_working_draft_sends%ROWTYPE;
  current_revision bigint;
  inserted_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

  IF p_expected_revision IS NULL OR p_expected_revision <= 0 THEN
    RETURN QUERY SELECT false, 'failed'::text, NULL::jsonb, 'EXPECTED_REVISION_REQUIRED'::text;
    RETURN;
  END IF;

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    RETURN QUERY SELECT false, 'discarded'::text, NULL::jsonb, 'DRAFT_DISCARDED'::text;
    RETURN;
  END IF;

  SELECT * INTO current_send
  FROM public.mail_working_draft_sends
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  -- Once SMTP may have been touched, idempotency outranks a repeated caller's
  -- revision. Never reopen or rebind an in-flight/sent logical Send.
  IF current_send.id IS NOT NULL AND current_send.state = 'sent' THEN
    RETURN QUERY SELECT false, current_send.state, current_send.smtp_result, current_send.error;
    RETURN;
  END IF;

  IF current_send.id IS NOT NULL AND current_send.state = 'sending' THEN
    RETURN QUERY SELECT false, current_send.state, current_send.smtp_result, current_send.error;
    RETURN;
  END IF;

  IF current_send.id IS NOT NULL
     AND current_send.state = 'preparing'
     AND current_send.lease_until IS NOT NULL
     AND current_send.lease_until >= now() THEN
    RETURN QUERY SELECT false, current_send.state, current_send.smtp_result, current_send.error;
    RETURN;
  END IF;

  SELECT revision INTO current_revision
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF current_revision IS NULL THEN
    RETURN QUERY SELECT false, 'failed'::text, NULL::jsonb, 'WORKING_DRAFT_NOT_FOUND'::text;
    RETURN;
  END IF;

  IF current_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, 'failed'::text, NULL::jsonb, 'WORKING_DRAFT_REVISION_CONFLICT'::text;
    RETURN;
  END IF;

  IF current_send.id IS NULL THEN
    INSERT INTO public.mail_working_draft_sends (
      draft_id, company_id, account_id, state, lease_until
    ) VALUES (
      p_draft_id, p_company_id, p_account_id, 'preparing', now() + interval '10 minutes'
    )
    RETURNING id INTO inserted_id;

    IF inserted_id IS NULL THEN
      RETURN QUERY SELECT false, 'failed'::text, NULL::jsonb, 'SEND_IDEMPOTENCY_CLAIM_FAILED'::text;
      RETURN;
    END IF;

    RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  IF current_send.state = 'failed'
     OR (current_send.state = 'preparing'
         AND (current_send.lease_until IS NULL OR current_send.lease_until < now())) THEN
    UPDATE public.mail_working_draft_sends
    SET state = 'preparing',
        error = NULL,
        smtp_result = NULL,
        lease_until = now() + interval '10 minutes',
        updated_at = now()
    WHERE id = current_send.id;
    RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, current_send.state, current_send.smtp_result, current_send.error;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid, bigint)
  TO service_role;
