-- ============================================================
-- CRM — profile privilege columns (migration 034)
--
-- Mirrors supabase/migrations/034_fix_profiles_update_rls.sql.
-- Paste into Supabase Cloud -> SQL Editor and run. Idempotent.
--
-- WHAT IT STOPS
--
-- Without this trigger, any signed-in user promotes themselves with a
-- single request from the browser console:
--
--   PATCH /rest/v1/profiles?user_id=eq.<self>  {"account_role":"owner"}
--   PATCH /rest/v1/profiles?user_id=eq.<self>  {"account_id":"<victim>"}
--
-- Both slip past the RLS policy because `user_id` never changes: RLS
-- constrains WHICH ROWS you may write, not WHICH COLUMNS.
--
-- Until now this only shipped inside full-install.sql, so a project
-- created before it -- or migrated bundle by bundle -- could be
-- missing it with nothing to say so. check-applied.sql now has a row
-- for it; this file is what you run when that row says MISSING.
--
-- AFTER RUNNING, VERIFY FOR REAL. The catalog can only tell you the
-- trigger exists. See the curl at the bottom of check-applied.sql:
-- the promotion must come back 403 / 42501, and a plain name change
-- must still come back 204.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- ============================================================
-- Validation
--
-- Automated, and run on every `pnpm test:e2e`:
--   e2e/privilege-columns.spec.ts
--
-- Against a client project you have just migrated, the same four
-- checks by hand — the catalog can only tell you the trigger exists,
-- not that it works:
--
--   1. As a viewer/member JWT via PostgREST, both of these must
--      return 42501 (insufficient_privilege):
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "account_role": "owner" }
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "account_id": "<other>" }
--   2. A self-service edit that leaves both columns alone must
--      still succeed:
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "full_name": "New Name" }
--   3. The member/invitation RPCs (set_member_role,
--      transfer_account_ownership, redeem_invitation) must still
--      succeed — they run SECURITY DEFINER as postgres.
--
-- docs/deploy/check-applied.sql carries the copy-pasteable curl for
-- step 1, and docs/deploy/coolify.md places it in the deploy order.
-- ============================================================


-- ############################################################
-- ##  REGISTRO DE APLICACION  (P0-SEC-07)
-- ############################################################

-- Deja constancia de que este bundle se aplico, para que
-- docs/deploy/check-applied.sql pueda responder "que le falta a este
-- proyecto" sin deducirlo del esquema.
--
-- Va al FINAL a proposito: si el editor de Supabase corta el script a
-- la mitad, la fila no se escribe y check-applied ensena "el objeto
-- esta pero nadie lo registro". Registrar al principio daria por bueno
-- un bundle a medio aplicar.
--
-- La tabla se crea aqui si falta, en vez de depender de que la 053 se
-- haya corrido antes: los bundles se aplican en el orden que le
-- convenga a cada proyecto.
CREATE TABLE IF NOT EXISTS public.schema_release (
  version TEXT PRIMARY KEY,
  bundle TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
ALTER TABLE public.schema_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.schema_release FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.schema_release TO service_role;

INSERT INTO public.schema_release (version, bundle) VALUES
  ('034', 'docs/deploy/profile-privilege-columns.sql')
ON CONFLICT (version) DO NOTHING;
