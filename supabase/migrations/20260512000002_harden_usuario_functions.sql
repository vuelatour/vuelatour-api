-- Migration: 20260512000002_harden_usuario_functions
-- Addresses security advisors raised after the initial usuario migration:
--   - function_search_path_mutable (tg_set_updated_at)
--   - anon/authenticated_security_definer_function_executable (tg_handle_new_auth_user)

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.tg_handle_new_auth_user() from public;
revoke execute on function public.tg_handle_new_auth_user() from anon;
revoke execute on function public.tg_handle_new_auth_user() from authenticated;
