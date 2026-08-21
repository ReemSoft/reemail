-- MAILMAESTRO_WORKING_DRAFT_CROSS_INSTANCE_SINGLEFLIGHT
ALTER TABLE public.mail_working_draft_discards
  ADD COLUMN IF NOT EXISTS cleanup_claim_token uuid,
  ADD COLUMN IF NOT EXISTS cleanup_lease_until timestamptz;

ALTER TABLE public.mail_working_draft_attachments
  ADD COLUMN IF NOT EXISTS import_claim_token uuid,
  ADD COLUMN IF NOT EXISTS import_lease_until timestamptz;

CREATE OR REPLACE FUNCTION public.merge_mail_working_draft_provider_ref(
  p_draft_id uuid, p_company_id uuid, p_account_id uuid, p_ref jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mailmaestro-working-draft:' || p_company_id::text || ':' ||
    p_account_id::text || ':' || p_draft_id::text, 0
  ));
  IF p_ref IS NULL OR p_ref = 'null'::jsonb THEN RETURN; END IF;
  UPDATE public.mail_working_draft_discards
  SET provider_refs = (
    SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
    FROM jsonb_array_elements(
      mail_working_draft_discards.provider_refs || jsonb_build_array(p_ref)
    )
  ),
  cleanup_state = 'pending', cleanup_error = NULL,
  cleanup_claim_token = NULL, cleanup_lease_until = NULL, updated_at = now()
  WHERE draft_id = p_draft_id AND company_id = p_company_id AND account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.merge_mail_working_draft_provider_ref(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_mail_working_draft_provider_ref(uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_discard_cleanup(
  p_draft_id uuid, p_company_id uuid, p_account_id uuid
) RETURNS TABLE(claimed boolean, claim_token uuid, provider_refs jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE next_token uuid := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mailmaestro-working-draft:' || p_company_id::text || ':' ||
    p_account_id::text || ':' || p_draft_id::text, 0
  ));
  RETURN QUERY
  WITH claimed_row AS (
    UPDATE public.mail_working_draft_discards AS d
    SET cleanup_state='cleaning', cleanup_error=NULL, cleanup_claim_token=next_token,
        cleanup_lease_until=now()+interval '10 minutes', updated_at=now()
    WHERE d.draft_id=p_draft_id AND d.company_id=p_company_id AND d.account_id=p_account_id
      AND NOT (d.cleanup_state='cleaned' AND jsonb_typeof(d.provider_refs)='array'
               AND jsonb_array_length(d.provider_refs)=0)
      AND (d.cleanup_state<>'cleaning' OR d.cleanup_lease_until IS NULL OR d.cleanup_lease_until<now())
    RETURNING d.cleanup_claim_token, d.provider_refs
  )
  SELECT true, claimed_row.cleanup_claim_token, claimed_row.provider_refs FROM claimed_row;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::uuid, NULL::jsonb; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_mail_working_draft_discard_cleanup(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_discard_cleanup(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_mail_working_draft_discard_cleanup(
  p_draft_id uuid, p_company_id uuid, p_account_id uuid,
  p_claim_token uuid, p_removed_ref jsonb DEFAULT NULL
) RETURNS TABLE(accepted boolean, cleaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE remaining_refs jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mailmaestro-working-draft:' || p_company_id::text || ':' ||
    p_account_id::text || ':' || p_draft_id::text, 0
  ));
  SELECT provider_refs INTO remaining_refs
  FROM public.mail_working_draft_discards
  WHERE draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
    AND cleanup_state='cleaning' AND cleanup_claim_token=p_claim_token
    AND cleanup_lease_until IS NOT NULL AND cleanup_lease_until>=now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,false; RETURN; END IF;

  IF p_removed_ref IS NOT NULL AND p_removed_ref <> 'null'::jsonb THEN
    remaining_refs := (
      SELECT COALESCE(jsonb_agg(value),'[]'::jsonb)
      FROM jsonb_array_elements(remaining_refs) value WHERE value<>p_removed_ref
    );
    UPDATE public.mail_working_draft_discards
    SET provider_refs=remaining_refs, cleanup_lease_until=now()+interval '10 minutes', updated_at=now()
    WHERE draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
      AND cleanup_claim_token=p_claim_token;
  END IF;

  IF jsonb_typeof(remaining_refs)='array' AND jsonb_array_length(remaining_refs)>0 THEN
    RETURN QUERY SELECT true,false; RETURN;
  END IF;

  DELETE FROM public.mail_working_drafts
  WHERE id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id;

  UPDATE public.mail_working_draft_discards
  SET cleanup_state='cleaned', cleanup_error=NULL, cleanup_claim_token=NULL,
      cleanup_lease_until=NULL, updated_at=now()
  WHERE draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
    AND cleanup_claim_token=p_claim_token;
  RETURN QUERY SELECT true,true;
END;
$$;
REVOKE ALL ON FUNCTION public.advance_mail_working_draft_discard_cleanup(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_mail_working_draft_discard_cleanup(uuid,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_mail_working_draft_discard_cleanup(
  p_draft_id uuid, p_company_id uuid, p_account_id uuid, p_claim_token uuid, p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE failed_id uuid;
BEGIN
  UPDATE public.mail_working_draft_discards
  SET cleanup_state='failed', cleanup_error=left(coalesce(p_error,'PROVIDER_DRAFT_DELETE_FAILED'),120),
      cleanup_claim_token=NULL, cleanup_lease_until=NULL, updated_at=now()
  WHERE draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
    AND cleanup_state='cleaning' AND cleanup_claim_token=p_claim_token
  RETURNING id INTO failed_id;
  RETURN failed_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_mail_working_draft_discard_cleanup(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_mail_working_draft_discard_cleanup(uuid,uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_attachment_import(
  p_attachment_id uuid, p_draft_id uuid, p_company_id uuid, p_account_id uuid
) RETURNS TABLE(claimed boolean, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE next_token uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  WITH claimed_row AS (
    UPDATE public.mail_working_draft_attachments
    SET import_claim_token=next_token, import_lease_until=now()+interval '10 minutes'
    WHERE id=p_attachment_id AND draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
      AND storage_path IS NULL AND source_descriptor IS NOT NULL
      AND (import_claim_token IS NULL OR import_lease_until IS NULL OR import_lease_until<now())
    RETURNING import_claim_token
  )
  SELECT true,import_claim_token FROM claimed_row;
  IF NOT FOUND THEN RETURN QUERY SELECT false,NULL::uuid; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_attachment_import(
  p_attachment_id uuid, p_draft_id uuid, p_company_id uuid, p_account_id uuid,
  p_claim_token uuid, p_storage_path text, p_size_bytes bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE imported_id uuid;
BEGIN
  IF p_storage_path IS NULL OR length(p_storage_path)=0 OR p_size_bytes<0 THEN RETURN false; END IF;
  UPDATE public.mail_working_draft_attachments
  SET storage_path=p_storage_path, source_descriptor=NULL, size_bytes=p_size_bytes,
      import_claim_token=NULL, import_lease_until=NULL, updated_at=now()
  WHERE id=p_attachment_id AND draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
    AND storage_path IS NULL AND source_descriptor IS NOT NULL
    AND import_claim_token=p_claim_token
    AND import_lease_until IS NOT NULL AND import_lease_until>=now()
  RETURNING id INTO imported_id;
  RETURN imported_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid,uuid,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid,uuid,text,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.release_mail_working_draft_attachment_import(
  p_attachment_id uuid, p_draft_id uuid, p_company_id uuid, p_account_id uuid, p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE released_id uuid;
BEGIN
  UPDATE public.mail_working_draft_attachments
  SET import_claim_token=NULL, import_lease_until=NULL
  WHERE id=p_attachment_id AND draft_id=p_draft_id AND company_id=p_company_id AND account_id=p_account_id
    AND import_claim_token=p_claim_token
  RETURNING id INTO released_id;
  RETURN released_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.release_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_mail_working_draft_attachment_import(uuid,uuid,uuid,uuid,uuid) TO service_role;
