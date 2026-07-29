-- Remove the overly-permissive "Anyone can view active companies by slug" policy
-- that exposed every column of every active company to anon + authenticated.
DROP POLICY IF EXISTS "Anyone can view active companies by slug" ON public.companies;

-- Members of a company can read their own company's row (branding, name, etc.).
-- Admin/super-admin access is already covered by existing ALL policies.
CREATE POLICY "Members can view own company"
  ON public.companies
  FOR SELECT
  TO authenticated
  USING (
    is_active = true
    AND id = private.get_user_company(auth.uid())
  );