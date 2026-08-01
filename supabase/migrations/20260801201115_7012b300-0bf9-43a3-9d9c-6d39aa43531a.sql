ALTER TABLE public.mail_message_body_cache
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;