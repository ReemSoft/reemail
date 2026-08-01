ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS mailbox_group_id uuid;

DO $$
DECLARE r record; g uuid;
BEGIN
  FOR r IN SELECT id FROM public.mail_accounts ORDER BY created_at LOOP
    IF (SELECT mailbox_group_id FROM public.mail_accounts WHERE id = r.id) IS NOT NULL THEN
      CONTINUE;
    END IF;
    g := gen_random_uuid();
    WITH RECURSIVE edges AS (
      SELECT owner_account_id AS a, linked_account_id AS b FROM public.mail_account_links
      UNION
      SELECT linked_account_id AS a, owner_account_id AS b FROM public.mail_account_links
    ), comp(id) AS (
      SELECT r.id
      UNION
      SELECT e.b FROM edges e JOIN comp c ON c.id = e.a
    )
    UPDATE public.mail_accounts a
      SET mailbox_group_id = g
      WHERE a.id IN (SELECT id FROM comp);
  END LOOP;
END $$;

UPDATE public.mail_accounts SET mailbox_group_id = gen_random_uuid() WHERE mailbox_group_id IS NULL;

ALTER TABLE public.mail_accounts
  ALTER COLUMN mailbox_group_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN mailbox_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS mail_accounts_mailbox_group_idx
  ON public.mail_accounts (company_id, mailbox_group_id);

DROP TABLE IF EXISTS public.mail_account_links;