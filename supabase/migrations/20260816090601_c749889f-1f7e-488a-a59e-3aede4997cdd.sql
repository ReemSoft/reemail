GRANT SELECT ON public.mail_signatures TO service_role;

CREATE OR REPLACE FUNCTION public.save_mail_signature(p_account_id uuid, p_html text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id required' USING ERRCODE = '22023';
  END IF;
  IF p_html IS NULL OR octet_length(p_html) > 250000 THEN
    RAISE EXCEPTION 'signature html out of range' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.mail_signatures (account_id, html)
  VALUES (p_account_id, p_html)
  ON CONFLICT (account_id) DO UPDATE
    SET html = EXCLUDED.html,
        updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.save_mail_signature(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_mail_signature(uuid, text) TO service_role;