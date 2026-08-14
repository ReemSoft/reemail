CREATE OR REPLACE FUNCTION public.get_mail_conversation(
  _company_id uuid,
  _account_id uuid,
  _canonical text,
  _uid bigint,
  _limit integer DEFAULT 50
)
RETURNS TABLE (
  uid bigint,
  canonical text,
  uidvalidity bigint,
  subject text,
  from_addr jsonb,
  to_addrs jsonb,
  cc_addrs jsonb,
  internal_date timestamptz,
  seen boolean,
  flagged boolean,
  has_attachments boolean,
  message_id text,
  in_reply_to text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH RECURSIVE seed AS (
    SELECT m.message_id, m.in_reply_to
    FROM public.mail_messages m
    JOIN public.mail_folders f ON f.id = m.folder_id
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND f.canonical = _canonical
      AND m.uid = _uid
      AND m.deleted_at IS NULL
    LIMIT 1
  ), ids(id) AS (
    SELECT id
    FROM seed
    CROSS JOIN LATERAL (VALUES (message_id), (in_reply_to)) AS initial(id)
    WHERE id IS NOT NULL
    UNION
    SELECT linked.id
    FROM ids i
    JOIN public.mail_messages m
      ON m.company_id = _company_id AND m.account_id = _account_id
     AND m.deleted_at IS NULL
     AND (m.message_id = i.id OR m.in_reply_to = i.id)
    CROSS JOIN LATERAL (VALUES (m.message_id), (m.in_reply_to)) AS linked(id)
    WHERE linked.id IS NOT NULL
  )
  SELECT m.uid, f.canonical, f.uidvalidity, m.subject, m.from_addr, m.to_addrs,
         m.cc_addrs, m.internal_date, m.seen, m.flagged, m.has_attachments,
         m.message_id, m.in_reply_to
  FROM public.mail_messages m
  JOIN public.mail_folders f ON f.id = m.folder_id
  WHERE m.company_id = _company_id AND m.account_id = _account_id
    AND m.deleted_at IS NULL
    AND (m.message_id IN (SELECT id FROM ids) OR m.in_reply_to IN (SELECT id FROM ids))
  ORDER BY m.internal_date DESC NULLS LAST
  LIMIT LEAST(GREATEST(_limit, 1), 100)
$$;
REVOKE ALL ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) TO service_role;