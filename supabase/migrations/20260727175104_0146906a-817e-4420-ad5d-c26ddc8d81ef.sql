REVOKE EXECUTE ON FUNCTION public.enqueue_due_mail_sync_jobs() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_default_mail_sync_schedule(uuid, uuid) FROM anon, authenticated;