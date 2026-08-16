CREATE POLICY "mail_signatures_no_direct_client_access"
ON public.mail_signatures
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (false)
WITH CHECK (false);