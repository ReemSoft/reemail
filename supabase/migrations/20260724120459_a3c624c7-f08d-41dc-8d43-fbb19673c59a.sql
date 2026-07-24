
-- 1. Drop unused super_admin claim function
DROP FUNCTION IF EXISTS public.claim_super_admin();

-- 2. Lock down trigger function
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- 3. Move helper functions to a private schema (not exposed to PostgREST)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION private.get_user_company(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company_id FROM public.profiles WHERE id = _user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.is_company_admin(_user_id uuid, _company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'company_admin' AND company_id = _company_id
  );
$$;

GRANT EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_user_company(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_company_admin(uuid, uuid) TO authenticated, service_role;

-- 4. Recreate policies to reference private.* helpers

-- companies
DROP POLICY IF EXISTS "Company admins can update own company" ON public.companies;
CREATE POLICY "Company admins can update own company" ON public.companies
  FOR UPDATE USING (private.is_company_admin(auth.uid(), id))
  WITH CHECK (private.is_company_admin(auth.uid(), id));

DROP POLICY IF EXISTS "Super admins can do anything on companies" ON public.companies;
CREATE POLICY "Super admins can do anything on companies" ON public.companies
  FOR ALL USING (private.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (private.has_role(auth.uid(), 'super_admin'::public.app_role));

-- mail_accounts
DROP POLICY IF EXISTS "Users manage own mail accounts" ON public.mail_accounts;

DROP POLICY IF EXISTS "Company admins delete mail accounts" ON public.mail_accounts;
CREATE POLICY "Company admins delete mail accounts" ON public.mail_accounts
  FOR DELETE USING (private.is_company_admin(auth.uid(), company_id));

DROP POLICY IF EXISTS "Company admins insert mail accounts" ON public.mail_accounts;
CREATE POLICY "Company admins insert mail accounts" ON public.mail_accounts
  FOR INSERT WITH CHECK (
    private.is_company_admin(auth.uid(), company_id)
    AND (user_id IS NULL OR private.get_user_company(user_id) = company_id)
  );

DROP POLICY IF EXISTS "Company admins update mail accounts" ON public.mail_accounts;
CREATE POLICY "Company admins update mail accounts" ON public.mail_accounts
  FOR UPDATE USING (private.is_company_admin(auth.uid(), company_id))
  WITH CHECK (
    private.is_company_admin(auth.uid(), company_id)
    AND (user_id IS NULL OR private.get_user_company(user_id) = company_id)
  );

DROP POLICY IF EXISTS "Company admins view company mail accounts" ON public.mail_accounts;
CREATE POLICY "Company admins view company mail accounts" ON public.mail_accounts
  FOR SELECT USING (private.is_company_admin(auth.uid(), company_id));

-- profiles
DROP POLICY IF EXISTS "Company admins view their company profiles" ON public.profiles;
CREATE POLICY "Company admins view their company profiles" ON public.profiles
  FOR SELECT USING (company_id IS NOT NULL AND private.is_company_admin(auth.uid(), company_id));

DROP POLICY IF EXISTS "Super admins view all profiles" ON public.profiles;
CREATE POLICY "Super admins view all profiles" ON public.profiles
  FOR SELECT USING (private.has_role(auth.uid(), 'super_admin'::public.app_role));

-- user_roles
DROP POLICY IF EXISTS "Super admins view all roles" ON public.user_roles;
CREATE POLICY "Super admins view all roles" ON public.user_roles
  FOR SELECT USING (private.has_role(auth.uid(), 'super_admin'::public.app_role));

-- 5. Drop the old public helper functions now that policies no longer reference them
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);
DROP FUNCTION IF EXISTS public.get_user_company(uuid);
DROP FUNCTION IF EXISTS public.is_company_admin(uuid, uuid);
