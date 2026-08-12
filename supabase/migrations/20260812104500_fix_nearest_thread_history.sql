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
  WITH RECURSIVE anchor AS (
    SELECT
      m.message_id,
      m.in_reply_to,
      m.references_ids,
      m.id,
      m.internal_date,
      f.canonical,
      m.uid,
      m.uidvalidity
    FROM public.mail_messages m
    JOIN public.mail_folders f ON f.id = m.folder_id
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND f.canonical = _canonical
      AND m.uid = _uid
      AND m.deleted_at IS NULL
    ORDER BY
      CASE WHEN m.uidvalidity = f.uidvalidity THEN 0 ELSE 1 END,
      m.id DESC
    LIMIT 1
  ), seed_ids(id) AS (
    SELECT linked.id
    FROM anchor a
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[a.message_id, a.in_reply_to] || COALESCE(a.references_ids, '{}'::text[]),
        NULL
      )
    ) AS linked(id)
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
  ), previous AS (
    SELECT c.*
    FROM candidates c
    CROSS JOIN anchor a
    WHERE c.copy_rank = 1
      AND COALESCE(c.message_id, c.id::text) <> COALESCE(a.message_id, a.id::text)
      AND (
        COALESCE(c.internal_date, 'epoch'::timestamptz),
        CASE c.canonical
          WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'sent' THEN 2
          WHEN 'drafts' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5
          WHEN 'archive' THEN 6 WHEN 'all' THEN 7 ELSE 8
        END,
        c.uid,
        c.uidvalidity
      ) < (
        COALESCE(a.internal_date, 'epoch'::timestamptz),
        CASE a.canonical
          WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'sent' THEN 2
          WHEN 'drafts' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5
          WHEN 'archive' THEN 6 WHEN 'all' THEN 7 ELSE 8
        END,
        a.uid,
        a.uidvalidity
      )
  )
  SELECT
    p.uid,
    p.canonical,
    p.uidvalidity,
    p.subject,
    p.from_addr,
    p.to_addrs,
    p.cc_addrs,
    p.internal_date,
    p.seen,
    p.flagged,
    p.has_attachments,
    p.message_id,
    p.in_reply_to
  FROM previous p
  ORDER BY
    COALESCE(p.internal_date, 'epoch'::timestamptz) DESC,
    CASE p.canonical
      WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'sent' THEN 2
      WHEN 'drafts' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5
      WHEN 'archive' THEN 6 WHEN 'all' THEN 7 ELSE 8
    END DESC,
    p.uid DESC,
    p.uidvalidity DESC
  LIMIT LEAST(GREATEST(_limit, 1), 25)
$$;

REVOKE ALL ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) TO service_role;
