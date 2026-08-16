CREATE POLICY "mail_signature_images_no_direct_client_access"
ON storage.objects
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (bucket_id <> 'mail-signature-images')
WITH CHECK (bucket_id <> 'mail-signature-images');