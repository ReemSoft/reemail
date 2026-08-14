-- Canonicalize standards-shaped RFC Message-IDs. Physical application IDs,
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

CREATE OR REPLACE FUNCTION public.normalize_mail_rfc_message_id_array(_values text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(d.message_id ORDER BY d.first_ordinal), '{}'::text[])
  FROM (
    SELECT
      public.normalize_mail_rfc_message_id(raw_id) AS message_id,
      min(ordinality) AS first_ordinal
    FROM unnest(COALESCE(_values, '{}'::text[]))
      WITH ORDINALITY AS source_ids(raw_id, ordinality)
    WHERE public.normalize_mail_rfc_message_id(raw_id) IS NOT NULL
    GROUP BY public.normalize_mail_rfc_message_id(raw_id)
    ORDER BY min(ordinality)
    LIMIT 100
  ) d
$$;

-- One-time metadata-only repair. Future ingestion already writes this format.
-- The tuple comparison prevents rewriting rows whose final values are unchanged.
WITH normalized_values AS (
  SELECT
    m.id,
    public.normalize_mail_rfc_message_id(m.message_id) AS message_id,
    public.normalize_mail_rfc_message_id(m.in_reply_to) AS in_reply_to,
    public.normalize_mail_rfc_message_id_array(m.references_ids) AS references_ids
  FROM public.mail_messages m
)
UPDATE public.mail_messages m
SET
  message_id = n.message_id,
  in_reply_to = n.in_reply_to,
  references_ids = n.references_ids
FROM normalized_values n
WHERE m.id = n.id
  AND (m.message_id, m.in_reply_to, m.references_ids)
      IS DISTINCT FROM
      (n.message_id, n.in_reply_to, n.references_ids);

CREATE OR REPLACE FUNCTION public.mail_message_copy_signature(
  _internal_date timestamptz,
  _from_addr jsonb,
  _subject text,
  _size_bytes bigint
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _internal_date IS NULL
      OR NULLIF(lower(btrim(_from_addr->>'email')), '') IS NULL
      OR _subject IS NULL
      OR _size_bytes IS NULL
    THEN NULL
    ELSE jsonb_build_array(
      _internal_date,
      lower(btrim(_from_addr->>'email')),
      _subject,
      _size_bytes
    )::text
  END
$$;

-- Classify exactly one encountered canonical Message-ID. The equality predicate
-- is compatible with mail_messages_message_id_live_idx and never scans/groups
-- unrelated Message-IDs in the account. An ID with no local owner returns false,
-- so unknown references cannot bridge otherwise unrelated messages.
CREATE OR REPLACE FUNCTION public.mail_rfc_message_id_is_unambiguous(
  _company_id uuid,
  _account_id uuid,
  _message_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH first_two_owners AS MATERIALIZED (
    SELECT m.id
    FROM public.mail_messages m
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
      AND m.message_id = _message_id
    LIMIT 2
  ), owner_probe AS (
    SELECT count(*) AS owner_count
    FROM first_two_owners
  )
  SELECT CASE owner_probe.owner_count
    WHEN 0 THEN false
    WHEN 1 THEN true
    ELSE (
      SELECT
        bool_and(matches.copy_signature IS NOT NULL)
        AND count(DISTINCT matches.copy_signature) = 1
      FROM (
        SELECT public.mail_message_copy_signature(
          m.internal_date,
          m.from_addr,
          m.subject,
          m.size_bytes
        ) AS copy_signature
        FROM public.mail_messages m
        WHERE m.company_id = _company_id
          AND m.account_id = _account_id
          AND m.deleted_at IS NULL
          AND m.message_id = _message_id
      ) matches
    )
  END
  FROM owner_probe
$$;

REVOKE ALL ON FUNCTION public.normalize_mail_rfc_message_id(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normalize_mail_rfc_message_id_array(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mail_message_copy_signature(timestamptz, jsonb, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mail_rfc_message_id_is_unambiguous(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_mail_rfc_message_id(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mail_message_copy_signature(timestamptz, jsonb, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.mail_rfc_message_id_is_unambiguous(uuid, uuid, text) TO service_role;

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
  WITH RECURSIVE anchor AS (
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
      m.message_id,
      m.in_reply_to,
      m.references_ids
    FROM public.mail_folders f
    JOIN public.mail_messages m
      ON m.folder_id = f.id
     AND m.company_id = _company_id
     AND m.account_id = _account_id
     AND m.uid = _uid
     AND m.deleted_at IS NULL
    WHERE f.company_id = _company_id
      AND f.account_id = _account_id
      AND f.canonical = _canonical
    ORDER BY
      CASE WHEN m.uidvalidity = f.uidvalidity THEN 0 ELSE 1 END,
      m.id DESC
    LIMIT 1
  ), seed_candidates(id) AS (
    SELECT DISTINCT linked.id
    FROM anchor a
    CROSS JOIN LATERAL unnest(
      array_remove(
        ARRAY[a.message_id, a.in_reply_to] || COALESCE(a.references_ids, '{}'::text[]),
        NULL
      )
    ) AS linked(id)
    WHERE linked.id IS NOT NULL
    LIMIT 256
  ), seed_ids(id) AS (
    SELECT candidate.id
    FROM seed_candidates candidate
    WHERE public.mail_rfc_message_id_is_unambiguous(
      _company_id,
      _account_id,
      candidate.id
    )
  ), connected_ids(id) AS (
    SELECT id FROM seed_ids
    UNION
    SELECT linked.id
    FROM connected_ids current_id
    CROSS JOIN LATERAL (
      SELECT DISTINCT next_id.id
      FROM (
        SELECT m.id, m.message_id, m.in_reply_to, m.references_ids
        FROM public.mail_messages m
        WHERE m.company_id = _company_id
          AND m.account_id = _account_id
          AND m.deleted_at IS NULL
          AND m.message_id = current_id.id
        UNION
        SELECT m.id, m.message_id, m.in_reply_to, m.references_ids
        FROM public.mail_messages m
        WHERE m.company_id = _company_id
          AND m.account_id = _account_id
          AND m.deleted_at IS NULL
          AND m.in_reply_to = current_id.id
        UNION
        SELECT m.id, m.message_id, m.in_reply_to, m.references_ids
        FROM public.mail_messages m
        WHERE m.company_id = _company_id
          AND m.account_id = _account_id
          AND m.deleted_at IS NULL
          AND cardinality(m.references_ids) > 0
          AND m.references_ids @> ARRAY[current_id.id]
      ) connected_message
      CROSS JOIN LATERAL unnest(
        array_remove(
          ARRAY[connected_message.message_id, connected_message.in_reply_to]
            || COALESCE(connected_message.references_ids, '{}'::text[]),
          NULL
        )
      ) AS next_id(id)
      WHERE next_id.id IS NOT NULL
        AND next_id.id <> current_id.id
    ) linked
    WHERE public.mail_rfc_message_id_is_unambiguous(
      _company_id,
      _account_id,
      linked.id
    )
  ), candidate_ids(id) AS (
    SELECT m.id
    FROM connected_ids current_id
    JOIN public.mail_messages m ON m.message_id = current_id.id
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
    UNION
    SELECT m.id
    FROM connected_ids current_id
    JOIN public.mail_messages m ON m.in_reply_to = current_id.id
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
    UNION
    SELECT m.id
    FROM connected_ids current_id
    JOIN public.mail_messages m ON m.references_ids @> ARRAY[current_id.id]
    WHERE m.company_id = _company_id
      AND m.account_id = _account_id
      AND m.deleted_at IS NULL
      AND cardinality(m.references_ids) > 0
  ), candidate_rows AS (
    SELECT
      m.id,
      m.uid,
      m.uidvalidity,
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
      m.message_id,
      m.in_reply_to,
      signatures.copy_signature,
      CASE
        WHEN safe_message_id.id IS NOT NULL
          AND signatures.copy_signature IS NOT NULL
        THEN m.message_id || E'\x1f' || signatures.copy_signature
        ELSE m.id::text
      END AS logical_copy_key
    FROM candidate_ids candidate
    JOIN public.mail_messages m ON m.id = candidate.id
    JOIN public.mail_folders f
      ON f.id = m.folder_id
     AND f.company_id = _company_id
     AND f.account_id = _account_id
    LEFT JOIN connected_ids safe_message_id ON safe_message_id.id = m.message_id
    CROSS JOIN LATERAL (
      SELECT public.mail_message_copy_signature(
        m.internal_date,
        m.from_addr,
        m.subject,
        m.size_bytes
      ) AS copy_signature
    ) signatures
  ), anchor_identity AS (
    SELECT
      a.*,
      signatures.copy_signature,
      CASE
        WHEN safe_message_id.id IS NOT NULL
          AND signatures.copy_signature IS NOT NULL
        THEN a.message_id || E'\x1f' || signatures.copy_signature
        ELSE a.id::text
      END AS logical_copy_key
    FROM anchor a
    LEFT JOIN connected_ids safe_message_id ON safe_message_id.id = a.message_id
    CROSS JOIN LATERAL (
      SELECT public.mail_message_copy_signature(
        a.internal_date,
        a.from_addr,
        a.subject,
        a.size_bytes
      ) AS copy_signature
    ) signatures
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

REVOKE ALL ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mail_conversation(uuid, uuid, text, bigint, integer) TO service_role;
