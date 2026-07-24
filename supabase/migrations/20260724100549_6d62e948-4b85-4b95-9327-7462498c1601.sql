
-- 1) Company admins can INSERT/UPDATE/DELETE mail_accounts for users of their company
CREATE POLICY "Company admins insert mail accounts"
ON public.mail_accounts
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_company_admin(auth.uid(), company_id)
  AND public.get_user_company(user_id) = company_id
);

CREATE POLICY "Company admins update mail accounts"
ON public.mail_accounts
FOR UPDATE
TO authenticated
USING (public.is_company_admin(auth.uid(), company_id))
WITH CHECK (public.is_company_admin(auth.uid(), company_id));

CREATE POLICY "Company admins delete mail accounts"
ON public.mail_accounts
FOR DELETE
TO authenticated
USING (public.is_company_admin(auth.uid(), company_id));

-- 2) One-time bootstrap: any authenticated user can claim super_admin if none exists yet
CREATE OR REPLACE FUNCTION public.claim_super_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_company_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    RAISE EXCEPTION 'super admin already claimed';
  END IF;

  -- promote to super_admin
  INSERT INTO public.user_roles (user_id, role) VALUES (v_uid, 'super_admin');

  -- attach to Reemsoft demo company as company_admin so /company works too
  SELECT id INTO v_company_id FROM public.companies WHERE slug = 'reemsoft' LIMIT 1;
  IF v_company_id IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role, company_id)
    VALUES (v_uid, 'company_admin', v_company_id)
    ON CONFLICT DO NOTHING;

    UPDATE public.profiles
    SET company_id = v_company_id
    WHERE id = v_uid AND company_id IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'company_id', v_company_id);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_super_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.claim_super_admin() TO authenticated;
