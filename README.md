# vuelatour-api

API principal de **VuelaTour** (Aero Charter Cancún): sistema de control
financiero y operativo para una flota de 7 aviones chárter. NestJS 11 +
Supabase (Postgres, Auth, Storage). Desplegado en **Railway** (deploy
automático al hacer push a `main`).

Es el **hub de negocio**: CRUD, validación del JWT de Supabase, reglas de
negocio, sockets (Socket.IO), crones (`@nestjs/schedule`), sincronización con
Google Calendar, push FCM y orquestación de los demás servicios
(`vuelatour-pyservices` para PDF/Excel/IA, PAC FEL para CFDI).

> Referencia de negocio: `Docs Requerimientos/Diseño_Funcional_VuelaTour_v1.2.docx`
> (workspace raíz). Convenciones e invariantes para desarrollo: **CLAUDE.md**.

## Módulos principales (`src/modules/`)

| Módulo | Qué cubre |
|---|---|
| `flights` | Vuelos, escalas/tramos, tacómetros (captura, IA, deducción, confirmación de oficina), cobros, reporte por vuelo, tablero taco-live, crones (deducción en vivo cada 10 min, cierre nocturno de tacos 23:45 Cancún, autocierre de vuelos zombi 23:55) |
| `quotes` | Motor de cotización v1.3 (desglose canónico que suma exacto), versiones, ruta comercial vs itinerario operativo |
| `expenses` | Gastos (IA pre-llena desde ticket), combustible, bandeja de pendientes, export Excel |
| `profit-sharing` | Reparto de utilidades por avión/socio + **pre-cierre** (checklist de integridad del periodo) |
| `conciliacion` | Importación de estados de cuenta, auto-match de CARGOS↔gastos y ABONOS↔cobros, sugerencia IA, resumen por cuenta |
| `facturacion` | CFDI 4.0 vía FEL (emitir/cancelar/nota de crédito), buzón de facturas recibidas, cierre .zip |
| `inventory` | Cardex FIFO; una SALIDA genera gasto `REFACCION` medio `BODEGA` (excluido de conciliación) |
| `caja-chica` | Fondos por persona, reposiciones/reintegros, saldo = movimientos − gastos EFECTIVO |
| `aircraft` / `engines` / `propellers` | Expediente del avión, motores/hélices como entidades (horas de vida DERIVADAS de escalas), reserva de overhaul, seguros, squawks, servicio por horas |
| `expirations` / `alerts` | Vencimientos por fecha y por horas; alertas cron diarias (08:00 Cancún) con dedupe |
| `pilots` | Días de descanso (espejo en Google Calendar) |
| `calendar` | Sync one-way sistema→Google (evento por vuelo por día) |
| `dashboards` | Ejecutivo, operativo, gastos, tarjetas, horas por piloto |
| `me` / `users` | Perfil, invitaciones con allowlist, `GET /me/horas` (límite 90 hrs informativo) |

## Setup

```bash
npm install
cp .env.example .env   # ver docs/configuracion-produccion.md (workspace raíz)
npm run start:dev
```

Build de producción (el compilador necesita heap extra):

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

## Migraciones

Toda migración vive **versionada** en `supabase/migrations/` Y se aplica al
proyecto de producción (`bjesduasnzbzywofukbf`) vía MCP/SQL. Nunca una sin la
otra. Hay dos proyectos Supabase: verifica que sea el de producción antes de
migrar.

## Verificación

```bash
NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.build.json --noEmit
npm run lint
```

Salud de la cadena de IA (Railway): `GET /v1/vision/health` (rol ADMIN).
