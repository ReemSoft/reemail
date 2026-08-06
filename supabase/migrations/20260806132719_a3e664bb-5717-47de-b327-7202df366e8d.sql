
CREATE POLICY "company_logo_admin_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'company-logos'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'company_admin'
      AND ur.company_id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "company_logo_admin_update" ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'company-logos'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'company_admin'
      AND ur.company_id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "company_logo_admin_delete" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'company-logos'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'company_admin'
      AND ur.company_id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "company_logo_member_select" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'company-logos'
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.company_id::text = (storage.foldername(name))[1]
  )
);
