-- ============================================================
-- CRM — schema-release
-- Migration 053.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/schema-release.sql 053
--
-- HOW TO APPLY
--   1. Supabase Cloud -> SQL Editor -> New query.
--   2. Paste this whole file and run it.
--   3. THEN deploy the new app code (merge to main + redeploy).
--
-- Order matters, and this way round is the safe one: every change here
-- is additive (new tables, new columns with defaults), so the code
-- currently running in production keeps working against the new schema.
-- Deploying first would instead point the new code at tables that do
-- not exist yet.
--
-- Safe to re-run: tables use CREATE TABLE IF NOT EXISTS, columns use
-- ADD COLUMN IF NOT EXISTS, constraints and policies are dropped before
-- being recreated, and functions use CREATE OR REPLACE.
--
-- IF THE EDITOR STILL REPORTS A SYNTAX ERROR
--   It is splitting the script into statements and getting it wrong, not
--   objecting to the SQL. Run the file one section at a time: each
--   `-- ####` banner below starts a migration, and they are independent
--   in that order. The apostrophes in comments that caused this once
--   already are rewritten by the generator (see sanitize-comments.py).
-- ============================================================


-- ############################################################
-- ##  053_schema_release.sql
-- ############################################################

-- ============================================================
-- 053_schema_release
--
-- Un registro de qué se ha aplicado en cada proyecto (P0-SEC-07).
--
-- EL PROBLEMA
--
-- En este montaje no hay migration runner: los bundles de
-- docs/deploy/ se pegan a mano en el editor SQL de Supabase, y hasta
-- ahora NADA anotaba que se hubieran corrido. La única forma de
-- responder a «¿qué le falta a este cliente?» era mirar el esquema y
-- deducirlo — y deducir tiene un punto ciego: solo ve lo que dejó
-- rastro.
--
-- Ese punto ciego ya costó dos hallazgos reales en esta misma tanda
-- (P0-SEC-06): la migración 034 no tenía bundle propio, así que un
-- proyecto migrado release a release podía no tenerla; y
-- `check-applied.sql` ni siquiera la miraba. Ninguna de las dos cosas
-- era visible sin ir a leer el catálogo a mano.
--
-- QUÉ REGISTRA, Y POR QUÉ ASÍ
--
-- Una fila por MIGRACIÓN, no por bundle. Los bundles se solapan a
-- propósito —`full-install.sql` contiene las 53, `inbox-dedup.sql`
-- contiene de la 022 a la 036— así que registrar por bundle haría
-- imposible responder «¿tiene la 034?» sin saberse de memoria qué
-- contiene cada archivo. Registrando por migración, los dos caminos
-- convergen en el mismo hecho.
--
-- `applied_at` es el de la PRIMERA aplicación: el INSERT lleva
-- ON CONFLICT DO NOTHING, así que reejecutar un bundle no duplica
-- filas ni reescribe la fecha. Cuándo se aplicó por primera vez es el
-- dato con valor forense; cuándo se repitió, no.
--
-- ESTO NO SUSTITUYE A MIRAR EL ESQUEMA
--
-- Es un registro de lo que alguien DIJO que corrió; el catálogo es la
-- verdad de lo que hay. Pueden discrepar —un editor que corta el
-- script a la mitad deja la mitad de los objetos y la fila igual— y
-- `check-applied.sql` enseña las dos columnas juntas justo para que la
-- discrepancia salte a la vista en vez de esconderse.
--
-- Idempotente — seguro de reejecutar.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.schema_release (
  -- El número de la migración, tal como se llama en
  -- supabase/migrations/ (’034’, ’052’). TEXT y no INT para conservar
  -- los ceros a la izquierda: ’034’ ordena y se lee igual que el
  -- nombre del archivo, y ’34’ no.
  version TEXT PRIMARY KEY,
  -- Qué archivo la trajo. Con los bundles solapados, saber si una
  -- migración entró por `full-install.sql` o por su release suelta
  -- explica muchas discrepancias.
  bundle TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Quién la corrió. En el editor de Supabase será `postgres`; en un
  -- `db reset` local, también. Sirve para distinguir una aplicación
  -- manual de una automatizada el día que exista un runner.
  applied_by TEXT NOT NULL DEFAULT current_user
);

COMMENT ON TABLE public.schema_release IS
  'Registro de migraciones aplicadas. Una fila por migracion, no por bundle. Ver docs/deploy/README.md.';

-- No son datos de inquilino: es metadato del despliegue. Nadie que
-- llegue por PostgREST tiene por qué leerlo — enumerar qué parches
-- lleva un proyecto es justo lo que ayuda a quien busca uno que falte.
--
-- RLS activada sin ninguna politica: `anon` y `authenticated` obtienen
-- cero filas, `service_role` y `postgres` la ven entera. Los REVOKE
-- son explicitos por la misma razon que en la 052 — los privilegios
-- por defecto del esquema conceden a anon y authenticated al crear.
ALTER TABLE public.schema_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.schema_release FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.schema_release TO service_role;

-- ============================================================
-- Relleno retroactivo
--
-- Un proyecto que ya está al día no debe aparecer como si no tuviera
-- nada: eso convertiría el registro en ruido desde el primer día y
-- nadie volvería a mirarlo.
--
-- Se registra cada migración cuya huella se pueda comprobar en el
-- catálogo AHORA MISMO. No se da por hecho: si el objeto no está, la
-- fila no se escribe, y `check-applied.sql` lo señalará. Se marcan
-- como venidas de `full-install.sql` porque es lo único que se puede
-- afirmar con honestidad — no sabemos qué archivo las trajo.
-- ============================================================

INSERT INTO public.schema_release (version, bundle, applied_by)
SELECT v.version, 'docs/deploy/full-install.sql', 'backfill-053'
FROM (VALUES
  ('022', to_regclass('public.idx_contacts_account_phone_normalized') IS NOT NULL),
  ('036', to_regclass('public.idx_conversations_account_contact') IS NOT NULL),
  ('037', to_regclass('public.ad_campaigns') IS NOT NULL),
  ('040', to_regclass('public.tracked_links') IS NOT NULL),
  ('043', EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'brand_name')),
  ('044', EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'whatsapp_config' AND column_name = 'meta_app_id')),
  ('048', EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'brand_display_mode')),
  ('049', to_regclass('public.contact_tasks') IS NOT NULL),
  ('050', to_regclass('public.call_sessions') IS NOT NULL),
  ('051', EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'theme')),
  ('034', EXISTS (SELECT 1 FROM pg_trigger t
                  JOIN pg_class c ON c.oid = t.tgrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE NOT t.tgisinternal AND n.nspname = 'public'
                    AND c.relname = 'profiles'
                    AND t.tgname = 'enforce_profile_privilege_columns')),
  ('052', NOT EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.prosecdef
                        AND has_function_privilege('public', p.oid, 'EXECUTE')))
) AS v(version, present)
WHERE v.present
ON CONFLICT (version) DO NOTHING;

-- Y la propia 053, que por definición acaba de aplicarse.
INSERT INTO public.schema_release (version, bundle)
VALUES ('053', 'docs/deploy/schema-release.sql')
ON CONFLICT (version) DO NOTHING;

-- ############################################################
-- ##  REGISTRO DE APLICACION  (P0-SEC-07)
-- ############################################################

-- Deja constancia de que este bundle se aplicó, para que
-- docs/deploy/check-applied.sql pueda responder "que le falta a este
-- proyecto" sin deducirlo del esquema.
--
-- Una fila por MIGRACION, no por bundle: los bundles se solapan
-- (full-install contiene todas), asi que registrar por archivo haria
-- imposible saber si una migracion concreta esta puesta.
--
-- ON CONFLICT DO NOTHING: reejecutar no duplica filas ni reescribe la
-- fecha. La primera aplicacion es el dato con valor; la repeticion no.
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
  ('053', 'docs/deploy/schema-release.sql')
ON CONFLICT (version) DO NOTHING;
