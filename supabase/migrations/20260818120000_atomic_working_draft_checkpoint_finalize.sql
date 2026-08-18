-- MAILMAESTRO_WORKING_DRAFT_ATOMIC_CHECKPOINT_FINALIZE
--
-- Closes the APPEND-vs-Send race for provider interoperability checkpoints.
-- The IMAP APPEND itself remains outside this transaction; only the durable
-- checkpoint-commit decision is atomic with the current durable send state.

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
BEGIN
  IF p_expected_revision < 0 OR p_payload IS NULL THEN
    RAISE EXCEPTION 'invalid working draft mutation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_row
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
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

CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_checkpoint_if_active(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_checkpoint_revision bigint,
  p_success boolean,
  p_server_ref jsonb DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS TABLE(committed boolean, fenced boolean, send_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.mail_working_drafts%ROWTYPE;
  send_row public.mail_working_draft_sends%ROWTYPE;
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

  SELECT * INTO current_row
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, true, 'deleted'::text;
    RETURN;
  END IF;

  SELECT * INTO send_row
  FROM public.mail_working_draft_sends
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF FOUND AND send_row.state IN ('sending', 'sent') THEN
    RETURN QUERY SELECT false, true, send_row.state;
    RETURN;
  END IF;

  -- A stale/older checkpoint result must never overwrite the currently-claimed
  -- checkpoint target. This preserves the existing latest-wins revision fence.
  -- Send state is evaluated first so sending/sent always dominate stale results.
  IF current_row.remote_checkpoint_target_revision IS DISTINCT FROM p_checkpoint_revision THEN
    RETURN QUERY SELECT false, false, 'stale'::text;
    RETURN;
  END IF;

  UPDATE public.mail_working_drafts
  SET remote_checkpoint_revision = CASE
        WHEN p_success THEN GREATEST(remote_checkpoint_revision, p_checkpoint_revision)
        ELSE remote_checkpoint_revision
      END,
      remote_checkpoint_state = CASE
        WHEN p_success AND revision <= p_checkpoint_revision THEN 'checkpointed'
        WHEN p_success THEN 'pending'
        WHEN revision > p_checkpoint_revision THEN 'pending'
        ELSE 'failed'
      END,
      remote_checkpoint_lease_until = NULL,
      remote_checkpoint_error = CASE
        WHEN p_success THEN NULL
        ELSE left(coalesce(p_error, 'CHECKPOINT_FAILED'), 120)
      END,
      remote_server_ref = CASE
        WHEN p_success THEN p_server_ref
        ELSE remote_server_ref
      END,
      updated_at = now()
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id;

  RETURN QUERY
    SELECT true,
           false,
           coalesce(send_row.state, 'preparing')::text;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_mail_working_draft_checkpoint_if_active(uuid, uuid, uuid, bigint, boolean, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_mail_working_draft_checkpoint_if_active(uuid, uuid, uuid, bigint, boolean, jsonb, text)
  TO service_role;

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
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

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
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

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
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

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
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_draft_id::text,
      0
    )
  );

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
