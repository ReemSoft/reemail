-- =====================================================================
-- MailMaestro Sync Queue — R1 Foundation
-- =====================================================================

-- 1) Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pgmq;

-- 2) pgmq queues (idempotent)
DO $$ BEGIN
  PERFORM pgmq.create('mail_sync');
EXCEPTION WHEN duplicate_table OR unique_violation OR others THEN
  -- pgmq.create raises when queue exists; swallow to keep migration idempotent
  NULL;
END $$;

DO $$ BEGIN
  PERFORM pgmq.create('mail_sync_dead');
EXCEPTION WHEN duplicate_table OR unique_violation OR others THEN
  NULL;
END $$;

-- =====================================================================
-- 3) Dedupe table — one active row per (account, folder, kind)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.mail_sync_dedupe (
  dedupe_key text PRIMARY KEY,
  msg_id bigint NOT NULL DEFAULT 0,
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('initial','incremental','reconcile')),
  priority integer NOT NULL DEFAULT 100,
  attempt integer NOT NULL DEFAULT 0,
  worker_id text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_sync_dedupe_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id) ON DELETE CASCADE,
  CONSTRAINT mail_sync_dedupe_folder_company_fk
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id) ON DELETE CASCADE
);

GRANT ALL ON public.mail_sync_dedupe TO service_role;
-- Explicitly no grant to anon/authenticated (deny-all via RLS below).

ALTER TABLE public.mail_sync_dedupe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_sync_dedupe_deny_all ON public.mail_sync_dedupe;
CREATE POLICY mail_sync_dedupe_deny_all
  ON public.mail_sync_dedupe
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE INDEX IF NOT EXISTS mail_sync_dedupe_company_idx
  ON public.mail_sync_dedupe (company_id);
CREATE INDEX IF NOT EXISTS mail_sync_dedupe_account_folder_idx
  ON public.mail_sync_dedupe (account_id, folder_id);
CREATE INDEX IF NOT EXISTS mail_sync_dedupe_msg_id_idx
  ON public.mail_sync_dedupe (msg_id);

-- =====================================================================
-- 4) Schedule table — small SSOT for what to sync and when
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.mail_sync_schedule (
  account_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('incremental','reconcile')),
  cadence_seconds integer NOT NULL DEFAULT 300 CHECK (cadence_seconds BETWEEN 60 AND 86400),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  enabled boolean NOT NULL DEFAULT true,
  last_enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, folder_id, kind),
  CONSTRAINT mail_sync_schedule_account_company_fk
    FOREIGN KEY (account_id, company_id)
    REFERENCES public.mail_accounts (id, company_id) ON DELETE CASCADE,
  CONSTRAINT mail_sync_schedule_folder_company_fk
    FOREIGN KEY (folder_id, company_id)
    REFERENCES public.mail_folders (id, company_id) ON DELETE CASCADE
);

GRANT ALL ON public.mail_sync_schedule TO service_role;
ALTER TABLE public.mail_sync_schedule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_sync_schedule_deny_all ON public.mail_sync_schedule;
CREATE POLICY mail_sync_schedule_deny_all
  ON public.mail_sync_schedule
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE INDEX IF NOT EXISTS mail_sync_schedule_due_idx
  ON public.mail_sync_schedule (next_run_at)
  WHERE enabled = true;

-- Timestamp trigger (reuse existing set_updated_at() function)
DROP TRIGGER IF EXISTS mail_sync_dedupe_updated_at ON public.mail_sync_dedupe;
CREATE TRIGGER mail_sync_dedupe_updated_at
  BEFORE UPDATE ON public.mail_sync_dedupe
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS mail_sync_schedule_updated_at ON public.mail_sync_schedule;
CREATE TRIGGER mail_sync_schedule_updated_at
  BEFORE UPDATE ON public.mail_sync_schedule
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- 5) Private schema + tick token
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS mail_sync_private;
REVOKE ALL ON SCHEMA mail_sync_private FROM PUBLIC;
GRANT USAGE ON SCHEMA mail_sync_private TO service_role;

CREATE TABLE IF NOT EXISTS mail_sync_private.tick_token (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  token text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON mail_sync_private.tick_token FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mail_sync_private.tick_token TO service_role;

-- Seed a strong random token if not present. Never returned by any RPC.
INSERT INTO mail_sync_private.tick_token (id, token)
VALUES (true, encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- 6) RPCs — all SECURITY DEFINER with locked-down search_path
-- =====================================================================

-- ---- enqueue_mail_sync_job ----
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
  v_key text;
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

  -- Tenant isolation: account must belong to company; folder must belong to account+company
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

  v_key := p_account_id::text || '|' || p_folder_id::text || '|' || p_kind;

  -- Try to insert dedupe row; if already exists, return the existing msg_id
  INSERT INTO public.mail_sync_dedupe
    (dedupe_key, msg_id, company_id, account_id, folder_id, kind, priority)
  VALUES
    (v_key, 0, p_company_id, p_account_id, p_folder_id, p_kind, p_priority)
  ON CONFLICT (dedupe_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.msg_id INTO v_existing_msg_id
      FROM public.mail_sync_dedupe d
      WHERE d.dedupe_key = v_key;
    RETURN QUERY SELECT false, v_existing_msg_id, v_key;
    RETURN;
  END IF;

  -- Enqueue in pgmq
  SELECT pgmq.send(
    'mail_sync',
    jsonb_build_object(
      'company_id', p_company_id,
      'account_id', p_account_id,
      'folder_id',  p_folder_id,
      'kind',       p_kind,
      'priority',   p_priority,
      'dedupe_key', v_key,
      'attempt',    0,
      'enqueued_at', now()
    ),
    p_delay_seconds
  ) INTO v_msg_id;

  UPDATE public.mail_sync_dedupe
     SET msg_id = v_msg_id
   WHERE dedupe_key = v_key;

  RETURN QUERY SELECT true, v_msg_id, v_key;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_mail_sync_job(uuid,uuid,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_mail_sync_job(uuid,uuid,uuid,text,integer,integer) TO service_role;

-- ---- claim_mail_sync_jobs ----
-- Reads pgmq.q_mail_sync directly to apply fair-share and concurrency limits.
CREATE OR REPLACE FUNCTION public.claim_mail_sync_jobs(
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 90,
  p_global_concurrency integer DEFAULT 20,
  p_per_company_concurrency integer DEFAULT 2,
  p_per_account_concurrency integer DEFAULT 1
)
RETURNS TABLE(
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pgmq, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_lease timestamptz;
  v_running_total integer;
  v_capacity integer;
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker_id required';
  END IF;
  IF p_batch_size <= 0 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'batch_size out of range';
  END IF;
  IF p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds out of range';
  END IF;

  v_lease := v_now + make_interval(secs => p_lease_seconds);

  -- Currently running: vt in future AND has been read
  SELECT count(*) INTO v_running_total
    FROM pgmq.q_mail_sync q
   WHERE q.vt > v_now AND q.read_ct > 0;

  v_capacity := GREATEST(0, p_global_concurrency - v_running_total);
  IF v_capacity = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH
  running AS (
    SELECT
      (q.message->>'company_id')::uuid AS company_id,
      (q.message->>'account_id')::uuid AS account_id
    FROM pgmq.q_mail_sync q
    WHERE q.vt > v_now AND q.read_ct > 0
  ),
  running_by_company AS (
    SELECT company_id, count(*)::int AS c FROM running GROUP BY company_id
  ),
  running_by_account AS (
    SELECT account_id, count(*)::int AS c FROM running GROUP BY account_id
  ),
  candidates AS (
    SELECT q.msg_id,
           q.read_ct,
           q.enqueued_at,
           q.vt,
           q.message,
           (q.message->>'company_id')::uuid AS company_id,
           (q.message->>'account_id')::uuid AS account_id,
           COALESCE((q.message->>'priority')::int, 100) AS priority
      FROM pgmq.q_mail_sync q
     WHERE q.vt <= v_now
     ORDER BY priority ASC, q.enqueued_at ASC
     LIMIT 500
  ),
  eligible AS (
    SELECT c.*
      FROM candidates c
      LEFT JOIN running_by_company rc ON rc.company_id = c.company_id
      LEFT JOIN running_by_account  ra ON ra.account_id = c.account_id
     WHERE COALESCE(rc.c, 0) < p_per_company_concurrency
       AND COALESCE(ra.c, 0) < p_per_account_concurrency
  ),
  -- Fair-share: round-robin across companies via ROW_NUMBER
  ranked AS (
    SELECT e.*,
           ROW_NUMBER() OVER (
             PARTITION BY e.company_id
             ORDER BY e.priority ASC, e.enqueued_at ASC
           ) AS company_slot
      FROM eligible e
  ),
  selected AS (
    SELECT r.msg_id
      FROM ranked r
     ORDER BY r.company_slot ASC, r.priority ASC, r.enqueued_at ASC
     LIMIT LEAST(p_batch_size, v_capacity)
  ),
  locked AS (
    SELECT q.msg_id
      FROM pgmq.q_mail_sync q
     WHERE q.msg_id IN (SELECT s.msg_id FROM selected s)
       FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE pgmq.q_mail_sync q
       SET vt = v_lease,
           read_ct = q.read_ct + 1
     WHERE q.msg_id IN (SELECT l.msg_id FROM locked l)
    RETURNING q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message
  ),
  touched AS (
    UPDATE public.mail_sync_dedupe d
       SET worker_id = p_worker_id,
           claimed_at = v_now,
           attempt = d.attempt + 1
      FROM updated u
     WHERE d.msg_id = u.msg_id
    RETURNING d.msg_id
  )
  SELECT u.msg_id, u.read_ct, u.enqueued_at, u.vt, u.message
    FROM updated u;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mail_sync_jobs(text,integer,integer,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_mail_sync_jobs(text,integer,integer,integer,integer,integer) TO service_role;

-- ---- complete_mail_sync_job ----
CREATE OR REPLACE FUNCTION public.complete_mail_sync_job(
  p_worker_id text,
  p_msg_id bigint
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pgmq, pg_temp
AS $$
DECLARE
  v_owner text;
  v_deleted boolean;
BEGIN
  IF p_worker_id IS NULL OR p_msg_id IS NULL THEN
    RAISE EXCEPTION 'worker_id and msg_id required';
  END IF;

  SELECT worker_id INTO v_owner
    FROM public.mail_sync_dedupe
   WHERE msg_id = p_msg_id
   FOR UPDATE;

  IF v_owner IS NULL THEN
    -- Not tracked → treat as already completed (idempotent)
    RETURN false;
  END IF;
  IF v_owner <> p_worker_id THEN
    RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501';
  END IF;

  -- Archive the pgmq message (moves to pgmq.a_mail_sync for retention)
  SELECT pgmq.archive('mail_sync', p_msg_id) INTO v_deleted;

  DELETE FROM public.mail_sync_dedupe WHERE msg_id = p_msg_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_mail_sync_job(text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_mail_sync_job(text,bigint) TO service_role;

-- ---- fail_mail_sync_job ----
CREATE OR REPLACE FUNCTION public.fail_mail_sync_job(
  p_worker_id text,
  p_msg_id bigint,
  p_action text,          -- 'retry' | 'dead'
  p_delay_seconds integer,
  p_error_code text,
  p_error_message text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pgmq, pg_temp
AS $$
DECLARE
  v_owner text;
  v_msg jsonb;
  v_new_msg jsonb;
BEGIN
  IF p_action NOT IN ('retry','dead') THEN
    RAISE EXCEPTION 'invalid action: %', p_action;
  END IF;

  SELECT worker_id INTO v_owner
    FROM public.mail_sync_dedupe
   WHERE msg_id = p_msg_id
   FOR UPDATE;

  IF v_owner IS NULL THEN
    RETURN false;  -- idempotent
  END IF;
  IF v_owner <> p_worker_id THEN
    RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'retry' THEN
    IF p_delay_seconds IS NULL OR p_delay_seconds < 1 OR p_delay_seconds > 3600 THEN
      RAISE EXCEPTION 'delay_seconds out of range';
    END IF;
    -- Push visibility timeout out; release ownership so another worker can pick it up
    PERFORM pgmq.set_vt('mail_sync', p_msg_id, p_delay_seconds);
    UPDATE public.mail_sync_dedupe
       SET worker_id = NULL,
           claimed_at = NULL
     WHERE msg_id = p_msg_id;
    RETURN true;
  ELSE
    -- Dead: archive from main queue, push a copy to dead queue with error info
    SELECT q.message INTO v_msg FROM pgmq.q_mail_sync q WHERE q.msg_id = p_msg_id;
    v_new_msg := COALESCE(v_msg, '{}'::jsonb) || jsonb_build_object(
      'failed_at', now(),
      'error_code', COALESCE(NULLIF(p_error_code, ''), 'UNKNOWN')
      -- error_message intentionally excluded to avoid leaking secrets
    );
    PERFORM pgmq.send('mail_sync_dead', v_new_msg, 0);
    PERFORM pgmq.archive('mail_sync', p_msg_id);
    DELETE FROM public.mail_sync_dedupe WHERE msg_id = p_msg_id;
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_mail_sync_job(text,bigint,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_mail_sync_job(text,bigint,text,integer,text,text) TO service_role;

-- ---- cleanup_mail_sync_jobs ----
CREATE OR REPLACE FUNCTION public.cleanup_mail_sync_jobs(
  p_completed_retention_days integer DEFAULT 7,
  p_dead_retention_days integer DEFAULT 30
)
RETURNS TABLE(completed_purged bigint, dead_purged bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pgmq, pg_temp
AS $$
DECLARE
  v_c bigint := 0;
  v_d bigint := 0;
BEGIN
  IF p_completed_retention_days < 1 THEN RAISE EXCEPTION 'invalid retention'; END IF;
  IF p_dead_retention_days < 1 THEN RAISE EXCEPTION 'invalid retention'; END IF;

  WITH d AS (
    DELETE FROM pgmq.a_mail_sync
     WHERE archived_at < now() - make_interval(days => p_completed_retention_days)
     RETURNING 1
  )
  SELECT count(*) INTO v_c FROM d;

  WITH d AS (
    DELETE FROM pgmq.a_mail_sync_dead
     WHERE archived_at < now() - make_interval(days => p_dead_retention_days)
     RETURNING 1
  )
  SELECT count(*) INTO v_d FROM d;

  RETURN QUERY SELECT v_c, v_d;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_mail_sync_jobs(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_mail_sync_jobs(integer,integer) TO service_role;

-- ---- get_mail_sync_queue_metrics ----
CREATE OR REPLACE FUNCTION public.get_mail_sync_queue_metrics()
RETURNS TABLE(
  queued bigint,
  running bigint,
  dead bigint,
  archived_last_hour bigint,
  oldest_queued_seconds numeric,
  dedupe_active bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pgmq, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    (SELECT count(*)::bigint FROM pgmq.q_mail_sync WHERE vt <= v_now),
    (SELECT count(*)::bigint FROM pgmq.q_mail_sync WHERE vt > v_now AND read_ct > 0),
    (SELECT count(*)::bigint FROM pgmq.q_mail_sync_dead),
    (SELECT count(*)::bigint FROM pgmq.a_mail_sync WHERE archived_at > v_now - interval '1 hour'),
    (SELECT COALESCE(EXTRACT(EPOCH FROM (v_now - min(enqueued_at))), 0)::numeric
       FROM pgmq.q_mail_sync WHERE vt <= v_now),
    (SELECT count(*)::bigint FROM public.mail_sync_dedupe);
END;
$$;

REVOKE ALL ON FUNCTION public.get_mail_sync_queue_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mail_sync_queue_metrics() TO service_role;

-- ---- verify_mail_sync_tick_token ----
-- Returns boolean only; never reveals the token itself.
CREATE OR REPLACE FUNCTION public.verify_mail_sync_tick_token(p_token text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, mail_sync_private, pg_temp
AS $$
DECLARE
  v_stored text;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN false;
  END IF;
  SELECT token INTO v_stored FROM mail_sync_private.tick_token WHERE id = true;
  IF v_stored IS NULL THEN RETURN false; END IF;
  -- Constant-time compare: both are hex strings of same length in normal use.
  RETURN (length(p_token) = length(v_stored))
     AND (encode(digest(p_token, 'sha256'), 'hex') = encode(digest(v_stored, 'sha256'), 'hex'));
END;
$$;

REVOKE ALL ON FUNCTION public.verify_mail_sync_tick_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_mail_sync_tick_token(text) TO service_role;