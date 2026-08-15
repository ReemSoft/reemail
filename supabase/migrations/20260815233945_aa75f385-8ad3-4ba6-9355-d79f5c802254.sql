CREATE TABLE public.mail_signatures (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  html text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mail_signatures TO authenticated;
GRANT ALL ON public.mail_signatures TO service_role;

ALTER TABLE public.mail_signatures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own signature"
ON public.mail_signatures
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE TRIGGER mail_signatures_set_updated_at
BEFORE UPDATE ON public.mail_signatures
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();