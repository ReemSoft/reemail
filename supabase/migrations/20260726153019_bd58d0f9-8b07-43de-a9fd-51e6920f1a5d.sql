-- =========================================================
-- Schema Reconciliation Migration — Local Mail Index Pass A
-- Safe DROP/RECREATE: tables verified empty, no external FKs, no code deps.
-- Does NOT touch mail_accounts / email_domains / Phase 1 constraints on them.
-- =========================================================

BEGIN;

-- ---------- Drop old (order matters: children first) ----------
DROP TABLE IF EXISTS public.mail_sync_state;
DROP TABLE IF EXISTS public.mail_messages;
DROP TABLE IF EXISTS public.mail_folders;

-- =========================================================
-- mail_folders
-- =========================================================
CREATE TABLE public.mail_folders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  company_id    uuid NOT NULL,
  path          text NOT NULL,
  delimiter     text,
  canonical     text NULL,
  supported     boolean NOT NULL DEFAULT true,
  uidvalidity   bigint,
  uidnext       bigint,
  highest_modseq numeric(20,0),
  total         integer NOT NULL DEFAULT 0,
  unread        integer NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_folders_path_not_blank CHECK (length(btrim(path)) > 0),
  CONSTRAINT mail_folders_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_folders_account_path_key UNIQUE (account_id, path),
  CONSTRAINT mail_folders_id_company_key UNIQUE (id, company_id)
);

GRANT ALL ON public.mail_folders TO service_role;

ALTER TABLE public.mail_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_folders_deny_all"
  ON public.mail_folders FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_folders_set_updated_at
  BEFORE UPDATE ON public.mail_folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX mail_folders_account_idx ON public.mail_folders(account_id);
CREATE INDEX mail_folders_company_idx ON public.mail_folders(company_id);

-- =========================================================
-- mail_messages
-- =========================================================
CREATE TABLE public.mail_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  company_id      uuid NOT NULL,
  folder_id       uuid NOT NULL,
  uid             bigint NOT NULL,
  uidvalidity     bigint NOT NULL,
  modseq          numeric(20,0),
  message_id      text,
  in_reply_to     text,
  subject         text,
  from_addr       jsonb,
  to_addrs        jsonb,
  cc_addrs        jsonb,
  internal_date   timestamptz,
  size_bytes      bigint,
  has_attachments boolean NOT NULL DEFAULT false,
  seen            boolean NOT NULL DEFAULT false,
  flagged         boolean NOT NULL DEFAULT false,
  answered        boolean NOT NULL DEFAULT false,
  draft           boolean NOT NULL DEFAULT false,
  keywords        text[] NOT NULL DEFAULT '{}',
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_messages_uid_positive CHECK (uid > 0),
  CONSTRAINT mail_messages_uidvalidity_nonneg CHECK (uidvalidity >= 0),
  CONSTRAINT mail_messages_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_messages_folder_company_fkey
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_messages_uniq_uid
    UNIQUE (account_id, folder_id, uidvalidity, uid)
);

GRANT ALL ON public.mail_messages TO service_role;

ALTER TABLE public.mail_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_messages_deny_all"
  ON public.mail_messages FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_messages_set_updated_at
  BEFORE UPDATE ON public.mail_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Cursor index over live messages only (tombstones excluded).
CREATE INDEX mail_messages_cursor_idx
  ON public.mail_messages (account_id, folder_id, internal_date DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX mail_messages_company_idx ON public.mail_messages(company_id);
CREATE INDEX mail_messages_unread_idx
  ON public.mail_messages(folder_id)
  WHERE seen = false AND deleted_at IS NULL;
CREATE INDEX mail_messages_flagged_idx
  ON public.mail_messages(account_id)
  WHERE flagged = true AND deleted_at IS NULL;

-- =========================================================
-- mail_sync_state
-- =========================================================
CREATE TABLE public.mail_sync_state (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL,
  company_id            uuid NOT NULL,
  folder_id             uuid,
  sync_status           text NOT NULL DEFAULT 'idle',
  uidvalidity           bigint,
  uidnext               bigint,
  highest_modseq        numeric(20,0),
  oldest_synced_uid     bigint,
  newest_synced_uid     bigint,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_reconcile_at     timestamptz,
  flags_need_reconcile  boolean NOT NULL DEFAULT false,
  attempts              integer NOT NULL DEFAULT 0,
  error_code            text,
  error_message         text,
  locked_by             text,
  locked_at             timestamptz,
  lock_expires_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_sync_state_status_check
    CHECK (sync_status IN ('idle','running','error','disabled')),
  CONSTRAINT mail_sync_state_lock_pair_check
    CHECK (
      (locked_by IS NULL AND locked_at IS NULL AND lock_expires_at IS NULL)
      OR (locked_by IS NOT NULL AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL)
    ),
  CONSTRAINT mail_sync_state_account_company_fkey
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_sync_state_folder_company_fkey
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id)
    ON DELETE CASCADE
);

GRANT ALL ON public.mail_sync_state TO service_role;

ALTER TABLE public.mail_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_sync_state_deny_all"
  ON public.mail_sync_state FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE TRIGGER mail_sync_state_set_updated_at
  BEFORE UPDATE ON public.mail_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Partial unique indexes cover both folder-scoped and account-scoped states.
CREATE UNIQUE INDEX mail_sync_state_folder_uniq
  ON public.mail_sync_state (account_id, folder_id)
  WHERE folder_id IS NOT NULL;

CREATE UNIQUE INDEX mail_sync_state_account_uniq
  ON public.mail_sync_state (account_id)
  WHERE folder_id IS NULL;

CREATE INDEX mail_sync_state_company_idx ON public.mail_sync_state(company_id);
CREATE INDEX mail_sync_state_running_idx
  ON public.mail_sync_state(lock_expires_at)
  WHERE sync_status = 'running';

-- =========================================================
-- Atomic lock functions (service_role only)
-- =========================================================

CREATE OR REPLACE FUNCTION public.claim_mail_sync_lock(
  p_account_id  uuid,
  p_company_id  uuid,
  p_folder_id   uuid,
  p_locked_by   text,
  p_ttl_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now       timestamptz := now();
  v_expires   timestamptz;
  v_rows      integer;
BEGIN
  IF p_locked_by IS NULL OR length(btrim(p_locked_by)) = 0 THEN
    RAISE EXCEPTION 'locked_by required';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 5 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'ttl_seconds must be between 5 and 3600';
  END IF;

  v_expires := v_now + make_interval(secs => p_ttl_seconds);

  -- Ensure row exists (folder-scoped or account-scoped).
  IF p_folder_id IS NULL THEN
    INSERT INTO public.mail_sync_state (account_id, company_id, folder_id)
    VALUES (p_account_id, p_company_id, NULL)
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.mail_sync_state (account_id, company_id, folder_id)
    VALUES (p_account_id, p_company_id, p_folder_id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Atomic claim: only if unlocked OR lock expired.
  UPDATE public.mail_sync_state
     SET locked_by       = p_locked_by,
         locked_at       = v_now,
         lock_expires_at = v_expires,
         sync_status     = 'running',
         last_attempt_at = v_now,
         attempts        = attempts + 1
   WHERE account_id = p_account_id
     AND company_id = p_company_id
     AND ((p_folder_id IS NULL AND folder_id IS NULL)
          OR (p_folder_id IS NOT NULL AND folder_id = p_folder_id))
     AND (locked_by IS NULL OR lock_expires_at <= v_now);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_sync_lock(uuid,uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mail_sync_lock(uuid,uuid,uuid,text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.release_mail_sync_lock(
  p_account_id  uuid,
  p_company_id  uuid,
  p_folder_id   uuid,
  p_locked_by   text,
  p_status      text,
  p_error_code  text DEFAULT NULL,
  p_error_msg   text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_status NOT IN ('idle','error','disabled') THEN
    RAISE EXCEPTION 'invalid release status: %', p_status;
  END IF;

  UPDATE public.mail_sync_state
     SET locked_by       = NULL,
         locked_at       = NULL,
         lock_expires_at = NULL,
         sync_status     = p_status,
         last_success_at = CASE WHEN p_status = 'idle' THEN now() ELSE last_success_at END,
         error_code      = CASE WHEN p_status = 'error' THEN p_error_code ELSE NULL END,
         error_message   = CASE WHEN p_status = 'error' THEN p_error_msg ELSE NULL END,
         attempts        = CASE WHEN p_status = 'idle' THEN 0 ELSE attempts END
   WHERE account_id = p_account_id
     AND company_id = p_company_id
     AND ((p_folder_id IS NULL AND folder_id IS NULL)
          OR (p_folder_id IS NOT NULL AND folder_id = p_folder_id))
     AND locked_by = p_locked_by;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_mail_sync_lock(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_mail_sync_lock(uuid,uuid,uuid,text,text,text,text) TO service_role;

COMMIT;