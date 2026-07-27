-- Explicitly revoke EXECUTE from anon/authenticated on all queue RPCs.
-- REVOKE FROM PUBLIC does not remove explicit role grants applied by
-- Supabase's default setup for public-schema functions.

REVOKE EXECUTE ON FUNCTION public.enqueue_mail_sync_job(uuid,uuid,uuid,text,integer,integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_mail_sync_jobs(text,integer,integer,integer,integer,integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_mail_sync_job(text,bigint) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_mail_sync_job(text,bigint,text,integer,text,text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_mail_sync_jobs(integer,integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_mail_sync_queue_metrics() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_mail_sync_tick_token(text) FROM anon, authenticated;