-- MAILMAESTRO_NORMAL_SEND_IDEMPOTENCY
--
-- Durable cross-instance single-flight for never-saved normal Compose sends.
-- Normal Compose and Working Draft use the same logical draft/send UUID and
-- the same transaction advisory-lock key so only one idempotency domain may
-- own SMTP at a time, even while a Compose is being promoted into a Draft.

CREATE TABLE IF NOT EXISTS public.mail_normal_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  message_id text NOT NULL,
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'sending', 'sent', 'failed')),
  smtp_result jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_normal_sends_identity_unique
    UNIQUE (send_id, company_id, account_id),
  CONSTRAINT mail_normal_sends_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts(id, company_id) ON DELETE CASCADE,
  CONSTRAINT mail_normal_sends_message_id_shape
    CHECK (
      char_length(message_id) BETWEEN 3 AND 998
      AND message_id LIKE '<%>'
      AND position(E'\r' in message_id) = 0
      AND position(E'\n' in message_id) = 0
      AND position('<' in substr(message_id, 2, char_length(message_id) - 2)) = 0
      AND position('>' in substr(message_id, 2, char_length(message_id) - 2)) = 0
    )
);

CREATE INDEX IF NOT EXISTS mail_normal_sends_account_updated_idx
  ON public.mail_normal_sends (company_id, account_id, updated_at DESC);

ALTER TABLE public.mail_normal_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_normal_sends FROM anon, authenticated;
GRANT ALL ON public.mail_normal_sends TO service_role;

DROP POLICY IF EXISTS "mail_normal_sends_no_direct_client_access"
  ON public.mail_normal_sends;
CREATE POLICY "mail_normal_sends_no_direct_client_access"
  ON public.mail_normal_sends AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

-- Claim normal-Compose ownership. Existing normal ownership outranks a later
-- Draft promotion. A new/reclaiming normal attempt is blocked if the logical
-- id has already entered the Working Draft domain.
CREATE OR REPLACE FUNCTION public.claim_mail_normal_send(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text
)
RETURNS TABLE(
  claimed boolean,
  state text,
  message_id text,
  smtp_result jsonb,
  error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.mail_normal_sends%ROWTYPE;
  working_revision bigint;
  working_state text;
  inserted_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_send_id::text,
      0
    )
  );

  SELECT s.* INTO current_row
  FROM public.mail_normal_sends AS s
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
  FOR UPDATE;

  IF current_row.id IS NOT NULL THEN
    IF current_row.message_id <> p_message_id THEN
      RETURN QUERY SELECT false, 'failed'::text, current_row.message_id,
        current_row.smtp_result, 'NORMAL_SEND_IDENTITY_MISMATCH'::text;
      RETURN;
    END IF;

    IF current_row.state = 'sent' THEN
      RETURN QUERY SELECT false, current_row.state, current_row.message_id,
        current_row.smtp_result, current_row.error;
      RETURN;
    END IF;

    IF current_row.state = 'sending' THEN
      RETURN QUERY SELECT false, current_row.state, current_row.message_id,
        current_row.smtp_result, current_row.error;
      RETURN;
    END IF;

    IF current_row.state = 'preparing'
       AND current_row.lease_until IS NOT NULL
       AND current_row.lease_until >= now() THEN
      RETURN QUERY SELECT false, current_row.state, current_row.message_id,
        current_row.smtp_result, current_row.error;
      RETURN;
    END IF;

    -- A handoff is permanent: stale normal tabs can never reopen SMTP even
    -- after the Working Draft row is eventually cleaned up.
    IF current_row.state = 'failed'
       AND current_row.error = 'HANDOFF_TO_WORKING_DRAFT' THEN
      RETURN QUERY SELECT false, current_row.state, current_row.message_id,
        current_row.smtp_result, 'NORMAL_SEND_HANDED_OFF'::text;
      RETURN;
    END IF;
  END IF;

  SELECT wd.revision INTO working_revision
  FROM public.mail_working_drafts AS wd
  WHERE wd.id = p_send_id
    AND wd.company_id = p_company_id
    AND wd.account_id = p_account_id
  FOR UPDATE;

  SELECT ws.state INTO working_state
  FROM public.mail_working_draft_sends AS ws
  WHERE ws.draft_id = p_send_id
    AND ws.company_id = p_company_id
    AND ws.account_id = p_account_id
  FOR UPDATE;

  IF working_revision IS NOT NULL
     OR working_state IN ('preparing', 'sending', 'sent') THEN
    RETURN QUERY SELECT false, 'failed'::text,
      COALESCE(current_row.message_id, p_message_id),
      current_row.smtp_result,
      'NORMAL_SEND_PROMOTED'::text;
    RETURN;
  END IF;

  IF current_row.id IS NULL THEN
    INSERT INTO public.mail_normal_sends AS s (
      send_id, company_id, account_id, message_id, state, lease_until
    ) VALUES (
      p_send_id, p_company_id, p_account_id, p_message_id,
      'preparing', now() + interval '10 minutes'
    )
    RETURNING s.id INTO inserted_id;

    IF inserted_id IS NULL THEN
      RAISE EXCEPTION 'NORMAL_SEND_INSERT_FAILED';
    END IF;

    RETURN QUERY
      SELECT true, 'preparing'::text, p_message_id, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  -- Only definite pre-SMTP failure or an expired preparation lease may be
  -- reclaimed automatically. 'sending' was returned above and is never here.
  UPDATE public.mail_normal_sends AS s
  SET state = 'preparing',
      error = NULL,
      smtp_result = NULL,
      lease_until = now() + interval '10 minutes',
      updated_at = now()
  WHERE s.id = current_row.id
    AND (
      current_row.state = 'failed'
      OR current_row.state = 'preparing'
    );

  RETURN QUERY
    SELECT true, 'preparing'::text, current_row.message_id, NULL::jsonb, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_normal_send(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_normal_send(uuid, uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_normal_send_in_flight(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_id uuid;
BEGIN
  UPDATE public.mail_normal_sends AS s
  SET state = 'sending',
      lease_until = NULL,
      updated_at = now()
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
    AND s.message_id = p_message_id
    AND s.state = 'preparing'
  RETURNING s.id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_normal_send_in_flight(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_normal_send_in_flight(uuid, uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_normal_send_sent(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text,
  p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_id uuid;
BEGIN
  UPDATE public.mail_normal_sends AS s
  SET state = 'sent',
      smtp_result = p_result,
      error = NULL,
      lease_until = NULL,
      updated_at = now()
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
    AND s.message_id = p_message_id
    AND s.state = 'sending'
  RETURNING s.id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_normal_send_sent(uuid, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_normal_send_sent(uuid, uuid, uuid, text, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.mark_mail_normal_send_failed(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_id uuid;
BEGIN
  UPDATE public.mail_normal_sends AS s
  SET state = 'failed',
      error = left(coalesce(p_error, 'SEND_FAILED'), 120),
      smtp_result = NULL,
      lease_until = NULL,
      updated_at = now()
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
    AND s.message_id = p_message_id
    AND s.state IN ('preparing', 'sending')
  RETURNING s.id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_normal_send_failed(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_normal_send_failed(uuid, uuid, uuid, text, text)
  TO service_role;

-- Explicit resend only. A 30-second propagation window mirrors the Working
-- Draft recovery contract. Promotion to a Working Draft permanently disables
-- this normal-domain reclaim path.
CREATE OR REPLACE FUNCTION public.reclaim_mail_normal_send_after_unknown(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  working_revision bigint;
  working_state text;
  updated_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_send_id::text,
      0
    )
  );

  SELECT wd.revision INTO working_revision
  FROM public.mail_working_drafts AS wd
  WHERE wd.id = p_send_id
    AND wd.company_id = p_company_id
    AND wd.account_id = p_account_id
  FOR UPDATE;

  SELECT ws.state INTO working_state
  FROM public.mail_working_draft_sends AS ws
  WHERE ws.draft_id = p_send_id
    AND ws.company_id = p_company_id
    AND ws.account_id = p_account_id
  FOR UPDATE;

  IF working_revision IS NOT NULL
     OR working_state IN ('preparing', 'sending', 'sent') THEN
    RETURN false;
  END IF;

  UPDATE public.mail_normal_sends AS s
  SET state = 'preparing',
      error = NULL,
      smtp_result = NULL,
      lease_until = now() + interval '10 minutes',
      updated_at = now()
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
    AND s.message_id = p_message_id
    AND s.state = 'sending'
    AND s.updated_at <= now() - interval '30 seconds'
  RETURNING s.id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_mail_normal_send_after_unknown(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_mail_normal_send_after_unknown(uuid, uuid, uuid, text)
  TO service_role;

-- Transfer durable ownership to the Working Draft domain. 'sending' may only
-- reach this RPC after explicit user confirmation in the trusted app server;
-- the same 30-second propagation window still applies. Failed or expired
-- preparing rows are safe pre-SMTP handoffs and need no user confirmation.
CREATE OR REPLACE FUNCTION public.handoff_mail_normal_send_to_working_draft(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.mail_normal_sends%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'mailmaestro-working-draft:' ||
      p_company_id::text || ':' ||
      p_account_id::text || ':' ||
      p_send_id::text,
      0
    )
  );

  SELECT s.* INTO current_row
  FROM public.mail_normal_sends AS s
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
  FOR UPDATE;

  IF current_row.id IS NULL THEN
    RETURN true;
  END IF;
  IF current_row.message_id <> p_message_id THEN
    RETURN false;
  END IF;
  IF current_row.state = 'sent' THEN
    RETURN false;
  END IF;
  IF current_row.state = 'failed'
     AND current_row.error = 'HANDOFF_TO_WORKING_DRAFT' THEN
    RETURN true;
  END IF;
  IF current_row.state = 'preparing'
     AND current_row.lease_until IS NOT NULL
     AND current_row.lease_until >= now() THEN
    RETURN false;
  END IF;
  IF current_row.state = 'sending'
     AND current_row.updated_at > now() - interval '30 seconds' THEN
    RETURN false;
  END IF;

  IF current_row.state = 'failed'
     OR current_row.state = 'preparing'
     OR current_row.state = 'sending' THEN
    UPDATE public.mail_normal_sends AS s
    SET state = 'failed',
        error = 'HANDOFF_TO_WORKING_DRAFT',
        smtp_result = NULL,
        lease_until = NULL,
        updated_at = now()
    WHERE s.id = current_row.id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.handoff_mail_normal_send_to_working_draft(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handoff_mail_normal_send_to_working_draft(uuid, uuid, uuid, text)
  TO service_role;

-- Once the Working Draft domain reaches durable 'sent', preserve that result
-- in any handed-off normal row so a stale normal tab also becomes idempotent
-- after Working Draft cleanup removes the draft row.
CREATE OR REPLACE FUNCTION public.mark_mail_normal_send_handoff_sent(
  p_send_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_id uuid;
BEGIN
  UPDATE public.mail_normal_sends AS s
  SET state = 'sent',
      smtp_result = p_result,
      error = NULL,
      lease_until = NULL,
      updated_at = now()
  WHERE s.send_id = p_send_id
    AND s.company_id = p_company_id
    AND s.account_id = p_account_id
    AND s.state = 'failed'
    AND s.error = 'HANDOFF_TO_WORKING_DRAFT'
  RETURNING s.id INTO updated_id;

  RETURN updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_mail_normal_send_handoff_sent(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_normal_send_handoff_sent(uuid, uuid, uuid, jsonb)
  TO service_role;

-- Extend the latest save revision fence across the normal-send domain too.
-- A normal send that may be active/sent blocks Draft persistence; a definitely
-- pre-SMTP failed/expired normal attempt is permanently handed off before save.
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
  current_normal public.mail_normal_sends%ROWTYPE;
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

  SELECT ns.* INTO current_normal
  FROM public.mail_normal_sends AS ns
  WHERE ns.send_id = p_draft_id
    AND ns.company_id = p_company_id
    AND ns.account_id = p_account_id
  FOR UPDATE;

  IF current_normal.id IS NOT NULL THEN
    IF current_normal.state IN ('sending', 'sent')
       OR (
         current_normal.state = 'preparing'
         AND current_normal.lease_until IS NOT NULL
         AND current_normal.lease_until >= now()
       ) THEN
      RETURN QUERY SELECT COALESCE(current_row.revision, 0)::bigint, true;
      RETURN;
    END IF;

    IF NOT (
      current_normal.state = 'failed'
      AND current_normal.error = 'HANDOFF_TO_WORKING_DRAFT'
    ) THEN
      UPDATE public.mail_normal_sends AS ns
      SET state = 'failed',
          error = 'HANDOFF_TO_WORKING_DRAFT',
          smtp_result = NULL,
          lease_until = NULL,
          updated_at = now()
      WHERE ns.id = current_normal.id
        AND (
          current_normal.state = 'failed'
          OR current_normal.state = 'preparing'
        );
    END IF;
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

-- Replace the latest revision-fenced Working Draft claim with the same logic
-- plus a cross-domain normal-send fence. This is migration-first safe: the
-- function signature is unchanged and old app instances remain compatible.
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
  current_normal public.mail_normal_sends%ROWTYPE;
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

  -- Existing Working Draft ownership outranks any later normal-domain row.
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

  SELECT ns.* INTO current_normal
  FROM public.mail_normal_sends AS ns
  WHERE ns.send_id = p_draft_id
    AND ns.company_id = p_company_id
    AND ns.account_id = p_account_id
  FOR UPDATE;

  IF current_normal.id IS NOT NULL THEN
    IF current_normal.state = 'sent' THEN
      RETURN QUERY SELECT false, 'sent'::text, current_normal.smtp_result, NULL::text;
      RETURN;
    END IF;

    IF current_normal.state = 'sending'
       OR (
         current_normal.state = 'preparing'
         AND current_normal.lease_until IS NOT NULL
         AND current_normal.lease_until >= now()
       ) THEN
      RETURN QUERY SELECT false, 'failed'::text, NULL::jsonb, 'NORMAL_SEND_ACTIVE'::text;
      RETURN;
    END IF;

    IF NOT (
      current_normal.state = 'failed'
      AND current_normal.error = 'HANDOFF_TO_WORKING_DRAFT'
    ) THEN
      -- Failed or expired preparing means SMTP was not known to be touched.
      -- Atomically fence stale normal tabs before this domain is allowed to own.
      UPDATE public.mail_normal_sends AS ns
      SET state = 'failed',
          error = 'HANDOFF_TO_WORKING_DRAFT',
          smtp_result = NULL,
          lease_until = NULL,
          updated_at = now()
      WHERE ns.id = current_normal.id
        AND (
          current_normal.state = 'failed'
          OR current_normal.state = 'preparing'
        );
    END IF;
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
