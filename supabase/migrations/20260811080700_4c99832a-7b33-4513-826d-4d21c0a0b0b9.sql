CREATE INDEX IF NOT EXISTS mail_messages_sender_keyset_idx
ON public.mail_messages (folder_id, lower(from_addr->>'email'), internal_date DESC, id DESC)
WHERE deleted_at IS NULL;