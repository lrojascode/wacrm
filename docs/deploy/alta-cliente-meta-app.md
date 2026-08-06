# Alta de un cliente con su propia app de Meta

Para un cliente que es dueño de su propio Business Manager y no va a dar
acceso de administrador a la app de Meta de la agencia. Requiere la
migración 044 ya aplicada — comprobar con
[`check-applied.sql`](check-applied.sql) antes de empezar.

## 1. El cliente crea su propia app en Meta

En [developers.facebook.com](https://developers.facebook.com), el cliente (o
quien administre su Business Manager) crea una app tipo *Business* y agrega
el producto WhatsApp, igual que describen los pasos 1 y 2 del panel lateral
de Ajustes → WhatsApp en wacrm. De ahí sale su propio **App ID** y **App
Secret** (Configuración de la app → Básica).

## 2. Guardar primero el número de WhatsApp

En wacrm, **antes** de tocar nada de la app de Meta: Ajustes → WhatsApp →
Credenciales de la API, y guardar `Phone Number ID`, `WABA ID` y el
`Access Token` como con cualquier número. Esto crea la fila de
`whatsapp_config` de la cuenta — sin ella no existe todavía una URL de
webhook propia a la que apuntar.

## 3. Configurar la app de Meta del cliente

Solo el **propietario** de la cuenta ve esta tarjeta. Bajando en la misma
página, en «Aplicación de Meta»:

1. Pegar el **App ID** y el **App Secret** del paso 1.
2. Guardar.
3. Copiar la **URL de callback del webhook para esta cuenta** que aparece
   ahí — es distinta de la URL genérica de arriba: lleva un token propio de
   esta cuenta (`/api/whatsapp/webhook/<token>`).

## 4. Registrar el webhook en la app del cliente

En el dashboard de la app del cliente en Meta: WhatsApp → Configuration →
Webhook → pegar la URL del paso 3, poner el mismo `Token de verificación
del webhook` que quedó guardado en el paso 2, y suscribirse al campo
`messages`.

## 5. Probar

Escribir al número desde un WhatsApp real y confirmar que el mensaje entra
en wacrm. Si no entra, revisar en el dashboard de la app del cliente en
Meta que la entrega del webhook no esté marcando error — un secreto mal
copiado da 401 en `/api/whatsapp/webhook/<token>`, visible en los logs del
servidor como `[webhook/token] rejected request with invalid signature`.

## Revertir

Si el cliente decide luego usar la app compartida de la agencia en vez de
la suya: en la tarjeta «Aplicación de Meta», botón «Volver a la app
compartida». Borra el App ID y el App Secret guardados; la cuenta vuelve a
verificarse contra el `META_APP_SECRET` del entorno. La URL de webhook
propia de la cuenta sigue funcionando igual — solo cambia contra qué
secreto se verifica.
