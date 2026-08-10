ALTER TABLE public.mail_messages
  ADD COLUMN IF NOT EXISTS references_ids text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS mail_messages_references_live_idx
  ON public.mail_messages USING gin (references_ids)
  WHERE deleted_at IS NULL AND cardinality(references_ids) > 0;

DROP FUNCTION IF EXISTS public.get_mail_conversation(uuid, uuid, text, bigint, integer);

CREATE OR REPLACE FUNCTION public.get_mail_conversation(
  _company_id uuid,
  _account_id uuid,
  _canonical text,
  _uid bigint,
  _limit integer DEFAULT 50
)
RETURNS TABLE(
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
SET search_path = public
AS $$
  WITH RECURSIVE seed_ids(id) AS (
    SELECT linked.id
    FROM public.mail_messages m
    JOIN public.mail_folders f ON f.id = m.folder_id
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[m.message_id, m.in_reply_to] || COALESCE(m.references_ids, '{}'::text[]),
        NULL
      )
    ) AS linked(id)
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND f.canonical = _canonical
      AND m.uid = _uid
      AND m.deleted_at IS NULL
    LIMIT 256
  ), connected_ids(id) AS (
    SELECT id FROM seed_ids
    UNION
    SELECT linked.id
    FROM connected_ids current_id
    JOIN public.mail_messages m
      ON m.company_id = _company_id
     AND m.account_id = _account_id
     AND m.deleted_at IS NULL
     AND (
       m.message_id = current_id.id
       OR m.in_reply_to = current_id.id
       OR m.references_ids @> ARRAY[current_id.id]
     )
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[m.message_id, m.in_reply_to] || COALESCE(m.references_ids, '{}'::text[]),
        NULL
      )
    ) AS linked(id)
  ), candidates AS (
    SELECT
      m.uid,
      f.canonical,
      m.uidvalidity,
      m.subject,
      m.from_addr,
      m.to_addrs,
      m.cc_addrs,
      m.internal_date,
      m.seen,
      m.flagged,
      m.has_attachments,
      m.message_id,
      m.in_reply_to,
      m.id,
      row_number() OVER (
        PARTITION BY COALESCE(m.message_id, m.id::text)
        ORDER BY
          CASE WHEN f.canonical = _canonical THEN 0 ELSE 1 END,
          m.internal_date ASC NULLS LAST,
          m.id ASC
      ) AS copy_rank
    FROM public.mail_messages m
    JOIN public.mail_folders f ON f.id = m.folder_id
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
      AND (
        m.message_id IN (SELECT id FROM connected_ids)
        OR m.in_reply_to IN (SELECT id FROM connected_ids)
        OR m.references_ids && ARRAY(SELECT id FROM connected_ids)
      )
  )
  SELECT
    c.uid,
    c.canonical,
    c.uidvalidity,
    c.subject,
    c.from_addr,
    c.to_addrs,
    c.cc_addrs,
    c.internal_date,
    c.seen,
    c.flagged,
    c.has_attachments,
    c.message_id,
    c.in_reply_to
  FROM candidates c
  WHERE c.copy_rank = 1
  ORDER BY c.internal_date ASC NULLS LAST, c.id ASC
  LIMIT LEAST(GREATEST(_limit, 1), 100)
$$;

REVOKE ALL ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) TO service_role;