# Bundles de despliegue

Este proyecto no tiene un ejecutor de migraciones en producción: el SQL se
pega a mano en el editor de Supabase Cloud. Los archivos de esta carpeta son
los que se pegan, y **todos se generan** desde `supabase/migrations/` con
`scripts/deploy/bundle-migrations.sh` — nunca se editan a mano, o dejan de
coincidir con lo que corre en local.

## Cuál usar

| Situación | Archivo |
|---|---|
| **Desplegar en un servicio nuevo, desde cero** | `full-install.sql` |
| Actualizar una base que ya está en producción | el bundle de la release correspondiente |
| Saber qué falta aplicar en una base | `check-applied.sql` |

### `full-install.sql` — instalación nueva

Contiene las 51 migraciones (001 a 051) en orden, en un solo archivo. Es lo
que hay que correr cuando se levanta el CRM en una cuenta de Supabase nueva:
otro cliente, otro entorno, una migración de proveedor.

Se corre **una vez**, antes de desplegar el código de la aplicación.

Después, `check-applied.sql` debe reportar todas las filas como `APPLIED`.

> **Pesa ~292 KB.** Si el editor de Supabase se atraganta o reporta un error
> de sintaxis que no tiene sentido, no es el SQL: es su separador de
> sentencias del lado del cliente. Cada migración empieza con un banner
> `-- ####` y son independientes en ese orden, así que se puede correr por
> tramos copiando de banner a banner.

### Bundles por release — base existente

`owner-only-settings.sql`, `brand-display.sql`, `contact-tasks.sql`,
`calls.sql`, `account-appearance.sql`, `ads-attribution.sql`, etc. Cada uno
cubre una entrega concreta.

Se mantienen uno por release a propósito: al pegarlos a mano, *"¿cuál me
falta correr?"* es exactamente la pregunta que un archivo fusionado vuelve
imposible de responder. `full-install.sql` no los reemplaza — resuelve un
problema distinto (empezar de cero, donde no hay historial que consultar).

**No corras `full-install.sql` sobre una base en producción** para "ponerla al
día". Es idempotente y no destruye datos, pero reejecuta 51 migraciones
enteras —incluidos rehacer políticas y restricciones— cuando lo que
necesitas son las dos que faltan. Usa `check-applied.sql` para saber cuáles
son y corre solo esos bundles.

## Regenerar

Tras añadir una migración nueva, hay tres cosas que actualizar:

```bash
# 1. El bundle de la release nueva
TITLE="mi release" ./scripts/deploy/bundle-migrations.sh docs/deploy/mi-release.sql 051

# 2. El de instalación completa (hay que listar TODAS las migraciones)
TITLE="full install (fresh deployment, all migrations)" \
  ./scripts/deploy/bundle-migrations.sh docs/deploy/full-install.sql \
  001 002 003 004 005 006 007 008 009 010 011 012 013 014 015 016 017 018 019 020 \
  021 022 023 024 025 026 027 028 029 030 031 032 033 034 035 036 037 038 039 040 \
  041 042 043 044 045 046 047 048 049 050 051
```

3. Añadir la fila correspondiente en `check-applied.sql`, detectando algo que
   solo esa migración cree.

> El script recibe los números como argumentos separados. En zsh, pasar una
> variable con saltos de línea **no** los separa: se manda como un solo
> argumento y el bundle sale vacío salvo la cabecera. Escríbelos en línea.

## Verificar un bundle antes de confiar en él

Lo que se hizo con `full-install.sql`, y conviene repetir si se regenera:

```bash
# 1. Aplica desde cero como script único, sin errores
psql "$DB_URL" -v ON_ERROR_STOP=1 -f docs/deploy/full-install.sql

# 2. Y produce el mismo esquema que las migraciones una a una
npx supabase db reset --local
```

Comparando tablas, columnas, políticas, funciones, índices y restricciones,
ambos caminos deben dar exactamente el mismo resultado.

## Nota sobre `supabase db reset` y la migración 047

Tras un `db reset` local, `check-applied.sql` reporta `047 owner-only
settings` como MISSING aunque la migración corrió. No es un fallo: el CLI de
Supabase reaplica su propio `GRANT ALL ON ALL TABLES` **después** de las
migraciones, y eso vuelve a abrir los permisos por columna que la 047
restringe. Solo pasa en local; producción aplica el bundle una vez y no corre
nada después. Para restaurarlo sin resetear:

```sql
REVOKE UPDATE ON accounts FROM authenticated;
GRANT UPDATE (name, default_currency) ON accounts TO authenticated;
```
