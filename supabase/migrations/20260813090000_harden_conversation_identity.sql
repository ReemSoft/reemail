-- Normalize only standards-shaped RFC Message-IDs. Physical application IDs,
-- UUIDs, malformed brackets, CR/LF and multi-ID scalar values fail closed.
CREATE OR REPLACE FUNCTION public.normalize_mail_rfc_message_id(_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
SET search_path = public
AS $$
  SELECT CASE
    WHEN btrim(_value) = '' OR btrim(_value) ~ E'[\r\n]' THEN NULL
    WHEN btrim(_value) ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$' THEN btrim(_value)
    WHEN btrim(_value) ~ '^[^<>[:space:]@]+@[^<>[:space:]@]+$' THEN '<' || btrim(_value) || '>'
    ELSE NULL
  END
$$;

REVOKE ALL ON FUNCTION public.normalize_mail_rfc_message_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_mail_rfc_message_id(text) TO service_role;

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
SECURITY INVOKER
SET search_path = public
AS $$
  WITH RECURSIVE scoped_rows AS MATERIALIZED (
    SELECT
      m.id,
      m.uid,
      m.uidvalidity,
      f.uidvalidity AS current_uidvalidity,
      f.canonical,
      m.subject,
      m.from_addr,
      m.to_addrs,
      m.cc_addrs,
      m.internal_date,
      m.size_bytes,
      m.seen,
      m.flagged,
      m.has_attachments,
      public.normalize_mail_rfc_message_id(m.message_id) AS message_id,
      public.normalize_mail_rfc_message_id(m.in_reply_to) AS in_reply_to,
      COALESCE(refs.normalized_references, '{}'::text[]) AS normalized_references,
      CASE
        WHEN public.normalize_mail_rfc_message_id(m.message_id) IS NOT NULL
         AND m.internal_date IS NOT NULL
         AND NULLIF(lower(btrim(m.from_addr->>'email')), '') IS NOT NULL
         AND m.subject IS NOT NULL
         AND m.size_bytes IS NOT NULL
        THEN jsonb_build_array(
          m.internal_date,
          lower(btrim(m.from_addr->>'email')),
          m.subject,
          m.size_bytes
        )::text
        ELSE NULL
      END AS copy_signature
    FROM public.mail_messages m
    JOIN public.mail_folders f
      ON f.id = m.folder_id
     AND f.company_id = _company_id
     AND f.account_id = _account_id
    LEFT JOIN LATERAL (
      SELECT array_agg(d.ref_id ORDER BY d.first_ordinal) AS normalized_references
      FROM (
        SELECT
          public.normalize_mail_rfc_message_id(raw_ref) AS ref_id,
          min(ordinality) AS first_ordinal
        FROM unnest(COALESCE(m.references_ids, '{}'::text[]))
          WITH ORDINALITY AS source_refs(raw_ref, ordinality)
        WHERE public.normalize_mail_rfc_message_id(raw_ref) IS NOT NULL
        GROUP BY public.normalize_mail_rfc_message_id(raw_ref)
        ORDER BY min(ordinality)
        LIMIT 100
      ) d
    ) refs ON true
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
  ), identity_stats AS MATERIALIZED (
    SELECT
      message_id,
      count(*) AS physical_row_count,
      count(DISTINCT copy_signature) AS signature_count,
      bool_and(copy_signature IS NOT NULL) AS signatures_complete
    FROM scoped_rows
    WHERE message_id IS NOT NULL
    GROUP BY message_id
  ), safe_message_ids AS MATERIALIZED (
    SELECT message_id AS id
    FROM identity_stats
    WHERE physical_row_count = 1
       OR (signatures_complete AND signature_count = 1)
  ), anchor AS (
    SELECT s.*
    FROM scoped_rows s
    WHERE s.canonical = _canonical
      AND s.uid = _uid
    ORDER BY
      CASE WHEN s.uidvalidity = s.current_uidvalidity THEN 0 ELSE 1 END,
      s.id DESC
    LIMIT 1
  ), seed_ids(id) AS (
    SELECT linked.id
    FROM anchor a
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[a.message_id, a.in_reply_to] || a.normalized_references,
        NULL
      )
    ) AS linked(id)
    JOIN safe_message_ids safe ON safe.id = linked.id
    LIMIT 256
  ), connected_ids(id) AS (
    SELECT id FROM seed_ids
    UNION
    SELECT linked.id
    FROM connected_ids current_id
    JOIN scoped_rows m ON (
      m.message_id = current_id.id
      OR m.in_reply_to = current_id.id
      OR current_id.id = ANY(m.normalized_references)
    )
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[m.message_id, m.in_reply_to] || m.normalized_references,
        NULL
      )
    ) AS linked(id)
    JOIN safe_message_ids safe ON safe.id = linked.id
  ), candidate_rows AS (
    SELECT
      s.*,
      CASE
        WHEN safe.id IS NOT NULL AND s.copy_signature IS NOT NULL
          THEN s.message_id || E'\x1f' || s.copy_signature
        ELSE s.id::text
      END AS logical_copy_key
    FROM scoped_rows s
    LEFT JOIN safe_message_ids safe ON safe.id = s.message_id
    WHERE s.message_id IN (SELECT id FROM connected_ids)
       OR s.in_reply_to IN (SELECT id FROM connected_ids)
       OR s.normalized_references && ARRAY(SELECT id FROM connected_ids)
  ), anchor_identity AS (
    SELECT
      CASE
        WHEN safe.id IS NOT NULL AND a.copy_signature IS NOT NULL
          THEN a.message_id || E'\x1f' || a.copy_signature
        ELSE a.id::text
      END AS logical_copy_key,
      a.internal_date,
      a.canonical,
      a.uid,
      a.uidvalidity
    FROM anchor a
    LEFT JOIN safe_message_ids safe ON safe.id = a.message_id
  ), ranked_copies AS (
    SELECT
      c.*,
      row_number() OVER (
        PARTITION BY c.logical_copy_key
        ORDER BY
          CASE WHEN c.canonical = _canonical THEN 0 ELSE 1 END,
          c.internal_date ASC NULLS LAST,
          CASE c.canonical
            WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'sent' THEN 2
            WHEN 'drafts' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5
            WHEN 'archive' THEN 6 WHEN 'all' THEN 7 ELSE 8
          END,
          c.uid ASC,
          c.uidvalidity ASC,
          c.id ASC
      ) AS copy_rank
    FROM candidate_rows c
  ), previous AS (
    SELECT c.*
    FROM ranked_copies c
    CROSS JOIN anchor_identity a
    WHERE c.copy_rank = 1
      AND c.logical_copy_key <> a.logical_copy_key
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
