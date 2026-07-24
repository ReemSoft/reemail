
REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_company(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_admin(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(UUID, UUID) TO authenticated;
