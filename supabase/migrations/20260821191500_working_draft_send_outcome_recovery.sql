-- MAILMAESTRO_WORKING_DRAFT_SEND_OUTCOME_RECOVERY
--
-- Persist a stable Message-ID before SMTP and allow an ambiguous 'sending'
-- attempt to be re-armed ONLY after an explicit user confirmation. There is
-- no automatic resend path. Existing 3-argument in-flight RPC remains intact
-- for migration-first rolling compatibility.

CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_in_flight(
  p_draft_id uuid,
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
  IF p_message_id IS NULL
     OR length(p_message_id) < 3
     OR length(p_message_id) > 998
     OR p_message_id !~ '^<[^<>\r\n]+>$' THEN
    RAISE EXCEPTION 'INVALID_MESSAGE_ID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mail_working_draft_sends
  SET state = 'sending',
      smtp_result = jsonb_build_object(
        'messageId', p_message_id,
        'startedAt', now()
      ),
      error = NULL,
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

REVOKE ALL ON FUNCTION public.mark_mail_working_draft_send_in_flight(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mail_working_draft_send_in_flight(
  uuid, uuid, uuid, text
) TO service_role;


CREATE OR REPLACE FUNCTION public.reclaim_mail_working_draft_send_after_unknown(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_expected_revision bigint,
  p_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_revision bigint;
  reclaimed_id uuid;
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

  IF p_expected_revision IS NULL
     OR p_expected_revision <= 0
     OR (p_message_id IS NOT NULL AND length(p_message_id) > 998) THEN
    RETURN false;
  END IF;

  IF public.is_mail_working_draft_discarded(
    p_draft_id, p_company_id, p_account_id
  ) THEN
    RETURN false;
  END IF;

  SELECT revision INTO current_revision
  FROM public.mail_working_drafts
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF current_revision IS NULL OR current_revision <> p_expected_revision THEN
    RETURN false;
  END IF;

  UPDATE public.mail_working_draft_sends
  SET state = 'preparing',
      smtp_result = NULL,
      error = NULL,
      lease_until = now() + interval '10 minutes',
      updated_at = now()
  WHERE draft_id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id
    AND state = 'sending'
    -- Even an explicit confirmation cannot re-arm immediately. Give the
    -- original SMTP/automatic-Sent-copy path a short propagation window first.
    AND updated_at <= now() - interval '30 seconds'
    AND (
      (
        p_message_id IS NOT NULL
        AND smtp_result ->> 'messageId' = p_message_id
      )
      OR (
        p_message_id IS NULL
        AND smtp_result IS NULL
      )
    )
  RETURNING id INTO reclaimed_id;

  RETURN reclaimed_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_mail_working_draft_send_after_unknown(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_mail_working_draft_send_after_unknown(
  uuid, uuid, uuid, bigint, text
) TO service_role;
