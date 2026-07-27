-- ============================================================
-- Phase-2: Dispatcher + pg_cron scheduler
-- ============================================================

-- 1) Dispatcher RPC: enqueue schedule rows that are due
CREATE OR REPLACE FUNCTION public.enqueue_due_mail_sync_jobs()
RETURNS TABLE(enqueued bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_count bigint := 0;
  r record;
BEGIN
  FOR r IN
    SELECT s.account_id, s.company_id, s.folder_id, s.kind, s.priority,
           s.cadence_seconds
      FROM public.mail_sync_schedule s
     WHERE s.enabled = true
       AND s.next_run_at <= v_now
     ORDER BY s.priority ASC, s.next_run_at ASC
     LIMIT 500
     FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.enqueue_mail_sync_job(
        r.account_id, r.company_id, r.folder_id,
        r.kind, r.priority, 0
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Non-fatal: log via NOTICE; skip so one bad row doesn't stall the tick.
      RAISE NOTICE 'enqueue_mail_sync_job failed for account=% folder=% kind=%: %',
        r.account_id, r.folder_id, r.kind, SQLERRM;
    END;

    UPDATE public.mail_sync_schedule
       SET last_enqueued_at = v_now,
           next_run_at = v_now + make_interval(secs => GREATEST(30, r.cadence_seconds))
     WHERE account_id = r.account_id
       AND folder_id = r.folder_id
       AND kind = r.kind;
  END LOOP;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_due_mail_sync_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_due_mail_sync_jobs() TO service_role;

-- 2) Convenience RPC: seed schedule for one (account, canonical-inbox folder)
CREATE OR REPLACE FUNCTION public.ensure_default_mail_sync_schedule(
  p_account_id uuid,
  p_company_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_folder_id uuid;
BEGIN
  SELECT id INTO v_folder_id
    FROM public.mail_folders
   WHERE account_id = p_account_id
     AND company_id = p_company_id
     AND canonical = 'inbox'
   LIMIT 1;
  IF v_folder_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.mail_sync_schedule
    (account_id, folder_id, company_id, kind, cadence_seconds, next_run_at, priority, enabled)
  VALUES
    (p_account_id, v_folder_id, p_company_id, 'incremental', 300, now(), 100, true)
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_default_mail_sync_schedule(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_default_mail_sync_schedule(uuid, uuid) TO service_role;

-- 3) Seed existing accounts (idempotent)
INSERT INTO public.mail_sync_schedule
  (account_id, folder_id, company_id, kind, cadence_seconds, next_run_at, priority, enabled)
SELECT a.id, f.id, a.company_id, 'incremental', 300, now(), 100, true
  FROM public.mail_accounts a
  JOIN public.mail_folders f
    ON f.account_id = a.id
   AND f.company_id = a.company_id
   AND f.canonical = 'inbox'
 WHERE a.credentials_ciphertext IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4) pg_cron: minute tick + daily cleanup
-- Unschedule prior copies (idempotent re-run of this migration)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mail-sync-tick-1min') THEN
    PERFORM cron.unschedule('mail-sync-tick-1min');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mail-sync-cleanup-daily') THEN
    PERFORM cron.unschedule('mail-sync-cleanup-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'mail-sync-tick-1min',
  '* * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://reemail.lovable.app/api/public/hooks/mail-sync-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mail-sync-tick-token', (SELECT token FROM mail_sync_private.tick_token WHERE id = true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $CRON$
);

SELECT cron.schedule(
  'mail-sync-cleanup-daily',
  '17 3 * * *',
  $CRON$
  SELECT public.cleanup_mail_sync_jobs(7, 30);
  $CRON$
);