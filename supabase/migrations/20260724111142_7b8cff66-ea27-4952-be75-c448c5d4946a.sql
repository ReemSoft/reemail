-- Client accounts are just email addresses under a company, not platform users.
ALTER TABLE public.mail_accounts ALTER COLUMN user_id DROP NOT NULL;

-- Ensure email_address is unique per company (used as login identifier)
CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_email_unique
  ON public.mail_accounts (LOWER(email_address));