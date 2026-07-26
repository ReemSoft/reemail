CREATE OR REPLACE FUNCTION public.adjust_mail_folder_counts_atomic(
  p_folder_id uuid,
  p_account_id uuid,
  p_company_id uuid,
  p_total_delta integer,
  p_unread_delta integer
)
RETURNS TABLE(total integer, unread integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_folder_id IS NULL OR p_account_id IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION 'folder_id, account_id, company_id are required';
  END IF;
  IF p_total_delta IS NULL OR p_total_delta < -100000 OR p_total_delta > 100000 THEN
    RAISE EXCEPTION 'total_delta out of range';
  END IF;
  IF p_unread_delta IS NULL OR p_unread_delta < -100000 OR p_unread_delta > 100000 THEN
    RAISE EXCEPTION 'unread_delta out of range';
  END IF;

  RETURN QUERY
  UPDATE public.mail_folders AS f
     SET total   = GREATEST(0, COALESCE(f.total, 0)  + p_total_delta),
         unread  = GREATEST(0, COALESCE(f.unread, 0) + p_unread_delta),
         updated_at = now()
   WHERE f.id = p_folder_id
     AND f.account_id = p_account_id
     AND f.company_id = p_company_id
  RETURNING f.total, f.unread;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_mail_folder_counts_atomic(uuid, uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_mail_folder_counts_atomic(uuid, uuid, uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.adjust_mail_folder_counts_atomic(uuid, uuid, uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_mail_folder_counts_atomic(uuid, uuid, uuid, integer, integer) TO service_role;