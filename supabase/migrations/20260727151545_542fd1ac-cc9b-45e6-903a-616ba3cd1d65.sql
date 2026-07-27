-- Fix 1: rename local var to avoid conflict with column name on ON CONFLICT
CREATE OR REPLACE FUNCTION public.enqueue_mail_sync_job(
  p_account_id uuid,
  p_company_id uuid,
  p_folder_id uuid,
  p_kind text,
  p_priority integer DEFAULT 100,
  p_delay_seconds integer DEFAULT 0
)
RETURNS TABLE(inserted boolean, msg_id bigint, dedupe_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dedupe_key text;
  v_msg_id bigint;
  v_existing_msg_id bigint;
BEGIN
  IF p_kind NOT IN ('initial','incremental','reconcile') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NULL OR p_priority < 0 OR p_priority > 1000 THEN
    RAISE EXCEPTION 'priority out of range' USING ERRCODE = '22003';
  END IF;
  IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'delay_seconds out of range' USING ERRCODE = '22003';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.mail_accounts
    WHERE id = p_account_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'account not found for company' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.mail_folders
    WHERE id = p_folder_id AND account_id = p_account_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'folder not found for account/company' USING ERRCODE = '42501';
  END IF;

  v_dedupe_key := p_account_id::text || '|' || p_folder_id::text || '|' || p_kind;

  INSERT INTO public.mail_sync_dedupe AS d
    (dedupe_key, msg_id, company_id, account_id, folder_id, kind, priority)
  VALUES
    (v_dedupe_key, 0, p_company_id, p_account_id, p_folder_id, p_kind, p_priority)
  ON CONFLICT (dedupe_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.msg_id INTO v_existing_msg_id
      FROM public.mail_sync_dedupe d
      WHERE d.dedupe_key = v_dedupe_key;
    RETURN QUERY SELECT false, v_existing_msg_id, v_dedupe_key;
    RETURN;
  END IF;

  SELECT pgmq.send(
    'mail_sync',
    jsonb_build_object(
      'company_id', p_company_id,
      'account_id', p_account_id,
      'folder_id',  p_folder_id,
      'kind',       p_kind,
      'priority',   p_priority,
      'dedupe_key', v_dedupe_key,
      'attempt',    0,
      'enqueued_at', now()
    ),
    p_delay_seconds
  ) INTO v_msg_id;

  UPDATE public.mail_sync_dedupe
     SET msg_id = v_msg_id
   WHERE mail_sync_dedupe.dedupe_key = v_dedupe_key;

  RETURN QUERY SELECT true, v_msg_id, v_dedupe_key;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_mail_sync_job(uuid,uuid,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_mail_sync_job(uuid,uuid,uuid,text,integer,integer) TO service_role;

-- Fix 2: pgcrypto lives in `extensions` schema
CREATE OR REPLACE FUNCTION public.verify_mail_sync_tick_token(p_token text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, mail_sync_private, extensions, pg_temp
AS $$
DECLARE
  v_stored text;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN false;
  END IF;
  SELECT token INTO v_stored FROM mail_sync_private.tick_token WHERE id = true;
  IF v_stored IS NULL THEN RETURN false; END IF;
  RETURN (length(p_token) = length(v_stored))
     AND (extensions.digest(p_token, 'sha256'::text) = extensions.digest(v_stored, 'sha256'::text));
END;
$$;

REVOKE ALL ON FUNCTION public.verify_mail_sync_tick_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_mail_sync_tick_token(text) TO service_role;