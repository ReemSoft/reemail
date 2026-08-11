CREATE TABLE public.mail_sender_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  sender_email text NOT NULL,
  display_name text,
  color text NOT NULL DEFAULT 'blue',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_sender_folders_email_unique UNIQUE (account_id, sender_email)
);

GRANT ALL ON public.mail_sender_folders TO service_role;
ALTER TABLE public.mail_sender_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY mail_sender_folders_deny_all ON public.mail_sender_folders
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TRIGGER mail_sender_folders_set_updated_at
  BEFORE UPDATE ON public.mail_sender_folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_mail_messages_sender_date
  ON public.mail_messages (folder_id, (lower(from_addr->>'email')), internal_date DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.list_mail_sender_messages(
  _company_id uuid,
  _account_id uuid,
  _folder_id uuid,
  _sender text,
  _limit integer DEFAULT 50,
  _cursor_date timestamptz DEFAULT NULL,
  _cursor_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  uid bigint,
  subject text,
  from_addr jsonb,
  to_addrs jsonb,
  cc_addrs jsonb,
  internal_date timestamptz,
  seen boolean,
  flagged boolean,
  has_attachments boolean,
  message_id text,
  in_reply_to text,
  references_ids text[]
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT m.id, m.uid, m.subject, m.from_addr, m.to_addrs, m.cc_addrs,
         m.internal_date, m.seen, m.flagged, m.has_attachments,
         m.message_id, m.in_reply_to, m.references_ids
    FROM public.mail_messages m
   WHERE m.company_id = _company_id
     AND m.account_id = _account_id
     AND m.folder_id = _folder_id
     AND m.deleted_at IS NULL
     AND lower(m.from_addr->>'email') = lower(btrim(_sender))
     AND (
       _cursor_date IS NULL
       OR m.internal_date < _cursor_date
       OR (m.internal_date = _cursor_date AND m.id < _cursor_id)
     )
   ORDER BY m.internal_date DESC NULLS LAST, m.id DESC
   LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

REVOKE ALL ON FUNCTION public.list_mail_sender_messages(uuid,uuid,uuid,text,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_mail_sender_messages(uuid,uuid,uuid,text,integer,timestamptz,uuid) TO service_role;