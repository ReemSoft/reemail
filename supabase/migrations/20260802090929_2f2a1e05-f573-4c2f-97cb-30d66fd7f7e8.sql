ALTER TABLE public.mail_message_body_cache
  ADD COLUMN IF NOT EXISTS inline_images jsonb NOT NULL DEFAULT '[]'::jsonb;