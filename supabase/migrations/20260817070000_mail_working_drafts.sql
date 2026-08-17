-- MAILMAESTRO_WORKING_DRAFTS_V1
--
-- Draft editing is server-first. IMAP remains a downstream checkpoint, never
-- the synchronous working-document store. These tables are intentionally
-- inaccessible to browser PostgREST clients: every operation is authenticated
-- by the Mail Session server routes and performed with service_role.

CREATE TABLE IF NOT EXISTS public.mail_working_drafts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  remote_checkpoint_revision bigint NOT NULL DEFAULT 0 CHECK (remote_checkpoint_revision >= 0),
  remote_checkpoint_target_revision bigint,
  remote_checkpoint_revision_id uuid,
  remote_checkpoint_state text NOT NULL DEFAULT 'pending'
    CHECK (remote_checkpoint_state IN ('pending', 'running', 'checkpointed', 'failed')),
  remote_checkpoint_lease_until timestamptz,
  remote_checkpoint_error text,
  remote_server_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_working_drafts_identity_unique UNIQUE (id, company_id, account_id),
  CONSTRAINT mail_working_drafts_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mail_working_drafts_account_updated_idx
  ON public.mail_working_drafts (company_id, account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.mail_working_draft_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES public.mail_working_drafts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  client_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('attachment', 'inline-image')),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  disposition text,
  cid text,
  storage_path text,
  source_descriptor jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_working_draft_attachments_draft_owner_fk
    FOREIGN KEY (draft_id, company_id, account_id)
    REFERENCES public.mail_working_drafts(id, company_id, account_id) ON DELETE CASCADE,
  CONSTRAINT mail_working_draft_attachments_client_key_unique
    UNIQUE (draft_id, client_key),
  CONSTRAINT mail_working_draft_attachments_owned_or_external
    CHECK (
      (storage_path IS NOT NULL AND source_descriptor IS NULL)
      OR (storage_path IS NULL AND source_descriptor IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS mail_working_draft_attachments_draft_idx
  ON public.mail_working_draft_attachments (draft_id, created_at);

ALTER TABLE public.mail_working_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_working_draft_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.mail_working_drafts FROM anon, authenticated;
REVOKE ALL ON public.mail_working_draft_attachments FROM anon, authenticated;
GRANT ALL ON public.mail_working_drafts TO service_role;
GRANT ALL ON public.mail_working_draft_attachments TO service_role;

DROP POLICY IF EXISTS "mail_working_drafts_no_direct_client_access" ON public.mail_working_drafts;
CREATE POLICY "mail_working_drafts_no_direct_client_access"
  ON public.mail_working_drafts AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "mail_working_draft_attachments_no_direct_client_access" ON public.mail_working_draft_attachments;
CREATE POLICY "mail_working_draft_attachments_no_direct_client_access"
  ON public.mail_working_draft_attachments AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('mail-draft-attachments', 'mail-draft-attachments', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "mail_draft_attachments_no_direct_client_access" ON storage.objects;
CREATE POLICY "mail_draft_attachments_no_direct_client_access"
  ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING (bucket_id <> 'mail-draft-attachments')
  WITH CHECK (bucket_id <> 'mail-draft-attachments');

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
      remote_checkpoint_state = 'pending',
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

CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_checkpoint(
  p_draft_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_checkpoint_revision bigint,
  p_success boolean,
  p_server_ref jsonb DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
      remote_checkpoint_error = CASE WHEN p_success THEN NULL ELSE left(coalesce(p_error, 'CHECKPOINT_FAILED'), 120) END,
      remote_server_ref = CASE WHEN p_success THEN p_server_ref ELSE remote_server_ref END,
      updated_at = now()
  WHERE id = p_draft_id
    AND company_id = p_company_id
    AND account_id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_mail_working_draft_checkpoint(uuid, uuid, uuid, bigint, boolean, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_mail_working_draft_checkpoint(uuid, uuid, uuid, bigint, boolean, jsonb, text)
  TO service_role;
