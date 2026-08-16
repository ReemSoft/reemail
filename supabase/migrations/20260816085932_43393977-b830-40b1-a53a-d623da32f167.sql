ALTER TABLE public.mail_signatures
  DROP CONSTRAINT IF EXISTS mail_signatures_user_id_fkey;

ALTER TABLE public.mail_signatures
  RENAME COLUMN user_id TO account_id;

ALTER TABLE public.mail_signatures
  ADD CONSTRAINT mail_signatures_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES public.mail_accounts(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "Users manage their own signature" ON public.mail_signatures;

REVOKE ALL ON public.mail_signatures FROM anon, authenticated;
GRANT ALL ON public.mail_signatures TO service_role;

COMMENT ON TABLE public.mail_signatures IS
  'One signature per verified mail account; accessed only through server functions that validate a Mail Session Token.';