-- MAILMAESTRO_WORKING_DRAFT_DISCARDS
--
-- Durable explicit-discard fence. Provider IMAP cleanup is async and must never
-- block composer close, allow a stale save/upload/Send to resurrect the Draft,
-- or let a running checkpoint APPEND republish it.

CREATE TABLE IF NOT EXISTS public.mail_working_draft_discards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  provider_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  cleanup_state text NOT NULL DEFAULT 'pending'
    CHECK (cleanup_state IN ('pending', 'cleaning', 'cleaned', 'failed')),
  cleanup_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_working_draft_discards_identity_unique
    UNIQUE (company_id, account_id, draft_id)
);

CREATE INDEX IF NOT EXISTS mail_working_draft_discards_account_idx
  ON public.mail_working_draft_discards (company_id, account_id, updated_at DESC);

ALTER TABLE public.mail_working_draft_discards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_working_draft_discards FROM anon, authenticated;
GRANT ALL ON public.mail_working_draft_discards TO service_role;

DROP POLICY IF EXISTS "mail_working_draft_discards_no_direct_client_access"
  ON public.mail_working_draft_discards;
CREATE POLICY "mail_working_draft_discards_no_direct_client_access"
  ON public.mail_working_draft_discards AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.merge_mail_working_draft_provider_ref(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_ref jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_ref IS NULL OR p_ref = 'null'::jsonb THEN
    RETURN;
  END IF;

  UPDATE public.mail_working_draft_discards
  SET provider_refs = (
    SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
    FROM jsonb_array_elements(
      mail_working_draft_discards.provider_refs || jsonb_build_array(p_ref)
    )
  ),
  cleanup_state = 'pending',
  cleanup_error = NULL,
  updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_mail_working_draft_provider_ref(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_mail_working_draft_provider_ref(uuid, uuid, uuid, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.discard_mail_working_draft(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_server_ref jsonb DEFAULT NULL,
  p_previous_ref jsonb DEFAULT NULL
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

  INSERT INTO public.mail_working_draft_discards (
    company_id, account_id, draft_id, provider_refs
  ) VALUES (
    p_company_id, p_account_id, p_draft_id, '[]'::jsonb
  )
  ON CONFLICT (company_id, account_id, draft_id) DO NOTHING;

  IF p_server_ref IS NOT NULL AND p_server_ref <> 'null'::jsonb THEN
    PERFORM public.merge_mail_working_draft_provider_ref(
      p_draft_id, p_company_id, p_account_id, p_server_ref
    );
  END IF;

  IF p_previous_ref IS NOT NULL AND p_previous_ref <> 'null'::jsonb THEN
    PERFORM public.merge_mail_working_draft_provider_ref(
      p_draft_id, p_company_id, p_account_id, p_previous_ref
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.discard_mail_working_draft(uuid, uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discard_mail_working_draft(uuid, uuid, uuid, jsonb, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.is_mail_working_draft_discarded(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.mail_working_draft_discards
    WHERE draft_id = p_draft_id
      AND company_id = p_company_id
      AND account_id = p_account_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_mail_working_draft_discarded(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_mail_working_draft_discarded(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.create_mail_working_draft_attachment(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_attachment_id uuid,
  p_client_key text,
  p_kind text,
  p_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_storage_path text,
  p_disposition text DEFAULT NULL,
  p_cid text DEFAULT NULL,
  p_source_descriptor jsonb DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_company uuid;
  existing_account uuid;
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

  SELECT company_id, account_id
  INTO existing_company, existing_account
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.mail_working_drafts (
      id, company_id, account_id, payload, revision
    ) VALUES (
      p_draft_id, p_company_id, p_account_id, p_payload, 0
    );
  ELSIF existing_company <> p_company_id OR existing_account <> p_account_id THEN
    RAISE EXCEPTION 'working draft ownership mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.mail_working_draft_attachments (
    id, draft_id, company_id, account_id, client_key, kind, filename,
    mime_type, size_bytes, disposition, cid, storage_path, source_descriptor
  ) VALUES (
    p_attachment_id, p_draft_id, p_company_id, p_account_id, p_client_key,
    p_kind, p_filename, p_mime_type, p_size_bytes, p_disposition, p_cid,
    p_storage_path, p_source_descriptor
  );

  RETURN p_attachment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_mail_working_draft_attachment(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, text, jsonb, jsonb
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mail_working_draft_attachment(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, text, jsonb, jsonb
)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_discard_cleanup(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_removed_ref jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  remaining_refs jsonb;
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

  IF p_removed_ref IS NOT NULL AND p_removed_ref <> 'null'::jsonb THEN
    UPDATE public.mail_working_draft_discards
    SET provider_refs = (
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      FROM jsonb_array_elements(mail_working_draft_discards.provider_refs) AS value
      WHERE value <> p_removed_ref
    ),
    updated_at = now()
    WHERE draft_id = p_draft_id
      AND company_id = p_company_id
      AND account_id = p_account_id;
  END IF;

  SELECT provider_refs
  INTO remaining_refs
  FROM public.mail_working_draft_discards
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(remaining_refs) = 'array'
     AND jsonb_array_length(remaining_refs) > 0 THEN
    RETURN false;
  END IF;

  DELETE FROM public.mail_working_drafts
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id;

  UPDATE public.mail_working_draft_discards
  SET cleanup_state = 'cleaned',
      cleanup_error = NULL,
      updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_mail_working_draft_discard_cleanup(
  uuid, uuid, uuid, jsonb
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_mail_working_draft_discard_cleanup(
  uuid, uuid, uuid, jsonb
)
  TO service_role;

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

CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_checkpoint(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_revision bigint
)
RETURNS TABLE(claimed boolean, revision_id uuid)
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

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  RETURN QUERY
  WITH claimed_row AS (
    UPDATE public.mail_working_drafts
  SET remote_checkpoint_state = 'running',
      remote_checkpoint_lease_until = now() + interval '10 minutes',
      remote_checkpoint_target_revision = p_revision,
      remote_checkpoint_revision_id = CASE
        WHEN remote_checkpoint_target_revision = p_revision
          AND remote_checkpoint_revision_id IS NOT NULL
        THEN remote_checkpoint_revision_id
        ELSE gen_random_uuid()
      END,
      remote_checkpoint_error = NULL,
      updated_at = now()
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
    AND revision >= p_revision
    AND remote_checkpoint_revision < p_revision
    AND (
      remote_checkpoint_state <> 'running'
      OR remote_checkpoint_lease_until IS NULL
      OR remote_checkpoint_lease_until < now()
    )
    RETURNING remote_checkpoint_revision_id
  )
  SELECT true, remote_checkpoint_revision_id FROM claimed_row;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_working_draft_checkpoint(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_checkpoint(uuid, uuid, uuid, bigint)
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

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    IF p_success AND p_server_ref IS NOT NULL AND p_server_ref <> 'null'::jsonb THEN
      PERFORM public.merge_mail_working_draft_provider_ref(
        p_draft_id, p_company_id, p_account_id, p_server_ref
      );
    END IF;
    RETURN QUERY SELECT false, true, 'discarded'::text;
    RETURN;
  END IF;

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
    SELECT true, false, coalesce(send_row.state, 'preparing')::text;
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

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    RETURN QUERY SELECT false, 'discarded'::text, NULL::jsonb, 'DRAFT_DISCARDED'::text;
    RETURN;
  END IF;

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

  IF public.is_mail_working_draft_discarded(p_draft_id, p_company_id, p_account_id) THEN
    RETURN false;
  END IF;

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
