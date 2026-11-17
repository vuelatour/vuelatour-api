// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que los demás specs del cotizador): notifications arrastra el
// gateway y `jose`; calendar-sync arrastra googleapis.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { QuotesService } from './quotes.service';
import { QuotesController } from './quotes.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { MetodoPago, TipoTarifa, TipoVuelo } from './dto/calculate-quote.dto';
import type { ReviseQuoteDto } from './dto/revise-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN — TRAMOS (22-sep-2026,
 * cotización #326; invariante 14 extendida del AVIÓN a los TRAMOS).
 *
 * Caso REAL del cliente: «antes de poner el tipo de cambio esta en 3596 y
 * despues de ponerlo, se cambia en automatico no se por que».
 *
 * - Cotizado el 19-sep: `T1 CUN→PTU FERRY` + `T2 PTU→CUN 2 pax`. La TUA se
 *   cobra en el aeropuerto de SALIDA de cada tramo CON pasajeros: el T1 sale
 *   de CUN vacío y el T2 sale de PTU (matrícula N exenta) ⇒ TUAS $0 ⇒
 *   subtotal $3,100.00 + IVA 16 % = **$3,596.00**.
 * - El 20-sep el PILOTO editó los DOS tramos desde la app: 4 pax y sin ferry
 *   (cambio OPERATIVO legítimo). Con la operación el T1 sale de CUN con 4
 *   pax ⇒ TUA CUN $25 × 4 = $100 + IVA ⇒ **$3,712.00**.
 *
 * Aquí se fija el contrato de punta a punta con un Supabase simulado: qué
 * TOTAL se guarda y qué columnas llegan (o no) a la escala VIVA.
 */

const N621TX = 'aaaaaaaa-0000-4000-8000-0000000n621tx';
const V326 = 'vvvvvvvv-0000-4000-8000-000000000326';
const USER = 'uuuuuuuu-0000-4000-8000-00000000000f';

type Row = Record<string, unknown>;
interface Op {
  tabla: string;
  tipo: 'select' | 'insert' | 'update' | 'delete';
  select: string;
  filtros: Array<[string, string, unknown]>;
  payload?: Row;
  single: boolean;
}

const FICHA = {
  id: N621TX,
  activa: true,
  matricula: 'N621TX',
  modelo: 'Kodiak 100',
  pais_registro: 'US',
  // 255 nm / 150 kts = 1.7 hr + 0.3 de calzos (2 aterrizajes) = 2.0 hr
  // cobrables × $1,550/hr = $3,100.00 de subtotal, en los DOS escenarios
  // (las millas no se mueven: la operación nunca escribe millas).
  velocidad_crucero_kts: 150,
  tarifa_hora_pub_usd: 1550,
  tarifa_hora_broker_usd: 1400,
  asientos: 9,
};

/** Tramo COTIZADO tal como lo dejó el motor el 19-sep (snapshot vigente). */
function tramoSnapshot(orden: number, extra: Row = {}): Row {
  const base =
    orden === 1
      ? {
          origen_iata: 'CUN',
          destino_iata: 'PTU',
          pasajeros: 0,
          es_ferry: true,
        }
      : {
          origen_iata: 'PTU',
          destino_iata: 'CUN',
          pasajeros: 2,
          es_ferry: false,
        };
  return {
    ...base,
    millas_nauticas: 127.5,
    pasajeros_nombres: [],
    requiere_pernocta: false,
    pernocta_costo_usd: 0,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    notas: null,
    fecha_salida_plan: null,
    pdf_oculto: null,
    ...extra,
  };
}

/** Escala VIVA tras la edición del PILOTO (4 pax, sin ferry). */
function escalaViva(orden: number, extra: Row = {}): Row {
  return {
    id: `e${orden}`,
    vuelo_id: V326,
    orden,
    origen_iata: orden === 1 ? 'CUN' : 'PTU',
    destino_iata: orden === 1 ? 'PTU' : 'CUN',
    aeronave_id: N621TX,
    millas_nauticas: 127.5,
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
    solo_operativa: false,
    pdf_oculto: false,
    pdf_fecha: null,
    requiere_pernocta: false,
    pernocta_costo_usd: null,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    notas: orden === 1 ? 'Cargar gasolina en PTU' : null,
    fecha_salida_plan: '2026-09-20T14:00:00.000Z',
    taco_salida: 100,
    taco_llegada: 101,
    cancelada_at: null,
    ...extra,
  };
}

function vueloRow(extra: Row = {}): Row {
  return {
    id: V326,
    folio: 326,
    cliente_id: 'c-palma',
    aeronave_id: N621TX,
    estado: 'COMPLETADO',
    es_externo: false,
    cotizacion_version: 1,
    facturado: false,
    cobrado: false,
    itinerario_operativo: false,
    pasajeros: 2,
    tarifa_tipo: 'PUBLICO',
    iva_pct: 0.16,
    monto_total_usd: 3596,
    subtotal_vuelo_usd: 3100,
    tuas_usd: 0,
    tc_usd_mxn: null,
    metodo_cobro: 'TRANSFERENCIA',
    extras: [],
    ajuste_final_usd: 0,
    comision_vendedor_usd: 0,
    notas: null,
    fecha_vuelo: new Date().toISOString(),
    fecha_traslado_final: null,
    pase_abordar: false,
    cotizacion_abierta: false,
    calculo_snapshot: {
      aeronave: { id: N621TX, matricula: 'N621TX', modelo: 'Kodiak 100' },
      ruta: { escalas: [tramoSnapshot(1), tramoSnapshot(2)] },
      tramos: [
        {
          orden: 1,
          origen: 'CUN',
          destino: 'PTU',
          millas: 127.5,
          pasajeros: 0,
          es_ferry: true,
        },
        {
          orden: 2,
          origen: 'PTU',
          destino: 'CUN',
          millas: 127.5,
          pasajeros: 2,
          es_ferry: false,
        },
      ],
      tiempos: { cobrable_hr: 2, cobrable_proviene_de_override: false },
      tarifa: { usd_por_hora: 1550 },
      tuas: { usd_pax_default: null, lineas_capturadas: [] },
      totales: { total_usd: 3596 },
      desglose: [],
      meta: {},
    },
    ...extra,
  };
}

interface Mundo {
  vuelo?: Row;
  escalas?: Row[];
  /**
   * Mundo VIVO (17-nov-2026, «Pasar estos tramos al vuelo»): las escrituras
   * SÍ cambian `vuelo` y `escalas`, y el CAS por `itinerario_operativo` se
   * respeta. Apagado (default) el arnés solo REGISTRA, como siempre.
   */
  vivo?: boolean;
}

function armar(m: Mundo = {}) {
  const log: Op[] = [];
  const vuelo = m.vuelo ?? vueloRow();
  const escalas = m.escalas ?? [escalaViva(1), escalaViva(2)];
  /** Mundo VIVO: una escritura de `escala` cambia la lista. */
  const aplicarEscala = (op: Op) => {
    const id = op.filtros.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2];
    if (op.tipo === 'update') {
      const fila = escalas.find((e) => e.id === id);
      if (fila) Object.assign(fila, op.payload);
    } else if (op.tipo === 'insert') {
      escalas.push({
        id: `nueva-${String((op.payload ?? {}).orden)}`,
        taco_salida: null,
        taco_llegada: null,
        cancelada_at: null,
        solo_operativa: false,
        ...op.payload,
      });
    } else if (op.tipo === 'delete') {
      const i = escalas.findIndex((e) => e.id === id);
      if (i >= 0) escalas.splice(i, 1);
    }
  };
  const supabase = {
    service: {
      from(tabla: string) {
        const op: Op = {
          tabla,
          tipo: 'select',
          select: '',
          filtros: [],
          single: false,
        };
        const resolver = (single: boolean) => {
          op.single = single;
          log.push(op);
          if (tabla === 'vuelo') {
            if (op.tipo === 'update') {
              if (m.vivo) {
                // CAS: `.eq('itinerario_operativo', X)` solo acierta si la
                // bandera sigue en X.
                const cas = op.filtros.find(
                  (f) => f[0] === 'eq' && f[1] === 'itinerario_operativo',
                );
                if (cas && vuelo.itinerario_operativo !== cas[2]) {
                  return { data: null };
                }
                Object.assign(vuelo, op.payload);
              }
              return { data: { ...vuelo, ...op.payload } };
            }
            return { data: single ? vuelo : [vuelo] };
          }
          if (tabla === 'escala') {
            if (op.tipo !== 'select') {
              if (m.vivo) aplicarEscala(op);
              return { data: single ? escalas[0] : [escalas[0]] };
            }
            // pernoctaDestinos: ningún tramo pernocta.
            if (op.select === 'orden, destino_iata') return { data: [] };
            return { data: single ? escalas[0] : escalas };
          }
          if (tabla === 'aeronave') {
            const ids = (op.filtros.find((f) => f[1] === 'id')?.[2] ??
              []) as string[];
            const lista = Array.isArray(ids) ? ids : [ids];
            return {
              data: lista.includes(N621TX) ? [FICHA] : [],
            };
          }
          if (tabla === 'cliente') {
            return { data: { es_interno: false, tarifas: [] } };
          }
          // cobro_vuelo (sin cobros), cotizacion_version_history (sin llave).
          return { data: single ? null : [] };
        };
        const q: Record<string, unknown> = {};
        const chain = () => q;
        q.select = jest.fn((s?: string) => {
          if (typeof s === 'string' && op.tipo === 'select') op.select = s;
          return q;
        });
        q.insert = jest.fn((p: Row) => {
          op.tipo = 'insert';
          op.payload = p;
          return q;
        });
        q.update = jest.fn((p: Row) => {
          op.tipo = 'update';
          op.payload = p;
          return q;
        });
        q.delete = jest.fn(() => {
          op.tipo = 'delete';
          return q;
        });
        for (const f of ['eq', 'is', 'in', 'neq', 'gte', 'lte', 'not']) {
          q[f] = jest.fn((k: string, v: unknown) => {
            op.filtros.push([f, k, v]);
            return q;
          });
        }
        for (const f of ['or', 'order', 'limit', 'range'])
          q[f] = jest.fn(chain);
        q.maybeSingle = jest.fn(() =>
          Promise.resolve({ ...resolver(true), error: null }),
        );
        q.single = q.maybeSingle;
        q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ ...resolver(false), error: null }).then(res, rej);
        return q;
      },
    },
  } as unknown as SupabaseService;

  // Mocks sueltos (sin `this`): se pasan a expect() sin desligar un método.
  const refreshPermisos = jest.fn().mockResolvedValue(undefined);
  const notifyUser = jest.fn().mockResolvedValue(true);
  const aircraft = {
    findById: jest.fn(() => Promise.resolve(FICHA)),
  } as unknown as AircraftService;
  // TUAS reales del caso: CUN cobra $25 por pasajero; en PTU la matrícula N
  // está exenta.
  const airports = {
    computeTuasUsdPax: jest.fn((iata: string) =>
      Promise.resolve(
        iata === 'CUN'
          ? { aplica: true, usd_pax: 25, razon: 'TUA CUN' }
          : { aplica: false, usd_pax: 0, razon: 'Matrícula N exenta' },
      ),
    ),
    anyRequiresPermit: jest.fn().mockResolvedValue(false),
    refreshPermisosDeVuelo: refreshPermisos,
  } as unknown as AirportsService;
  const notifications = {
    notifyUser,
    notifyRole: jest.fn().mockResolvedValue(true),
  } as unknown as NotificationsService;
  const service = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    {
      syncFlight: jest.fn(),
      removeEscalaEvent: jest.fn().mockResolvedValue(true),
    } as unknown as CalendarSyncService,
    {} as EmailService,
    notifications,
    {
      validateAssignTargets: jest
        .fn()
        .mockResolvedValue({ squawksAceptados: [], avisos: [] }),
      notificarSquawkAceptado: jest.fn(),
      avisoTallerDe: jest.fn().mockResolvedValue([]),
    } as unknown as FlightsService,
  );
  /** Patch que la revisión escribió en `vuelo` (el de los montos). */
  const patchVuelo = () =>
    log.find(
      (o) =>
        o.tabla === 'vuelo' &&
        o.tipo === 'update' &&
        'calculo_snapshot' in (o.payload ?? {}),
    )?.payload ?? null;
  /** Patch que llegó a la escala VIVA de ese orden (id = `e<orden>`). */
  const patchEscala = (orden: number) =>
    log.find(
      (o) =>
        o.tabla === 'escala' &&
        o.tipo === 'update' &&
        o.filtros.some((f) => f[1] === 'id' && f[2] === `e${orden}`),
    )?.payload ?? null;
  return {
    service,
    log,
    patchVuelo,
    patchEscala,
    vuelo,
    escalas,
    refreshPermisos,
    notifyUser,
  };
}

/** Tramos tal como los rehidrataría el panel NUEVO (del snapshot). */
const TRAMOS_COTIZADOS = [
  {
    origen_iata: 'CUN',
    destino_iata: 'PTU',
    millas_nauticas: 127.5,
    pasajeros: 0,
    pasajeros_nombres: [],
    es_ferry: true,
  },
  {
    origen_iata: 'PTU',
    destino_iata: 'CUN',
    millas_nauticas: 127.5,
    pasajeros: 2,
    pasajeros_nombres: [],
    es_ferry: false,
  },
];

/** Tramos tal como los rehidrataba el panel VIEJO (de la escala viva). */
const TRAMOS_OPERACION = [
  {
    origen_iata: 'CUN',
    destino_iata: 'PTU',
    millas_nauticas: 127.5,
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
  },
  {
    origen_iata: 'PTU',
    destino_iata: 'CUN',
    millas_nauticas: 127.5,
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
  },
];

function dtoRevision(extra: Partial<ReviseQuoteDto> = {}): ReviseQuoteDto {
  return {
    aeronave_id: N621TX,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: TRAMOS_COTIZADOS,
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 2,
    metodo_pago: MetodoPago.TRANSFERENCIA,
    motivo: 'Corrección',
    ...extra,
  };
}

describe('#326 — reabrir + teclear el T.C. NO mueve el total', () => {
  it('PANEL NUEVO (tramos_base COTIZADO): guarda $3,596.00 y la escala viva conserva los 4 pax del piloto', async () => {
    const w = armar();
    const r = await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO', tc_usd_mxn: 16.97 }),
      USER,
    );
    const patch = w.patchVuelo()!;
    expect(patch.monto_total_usd).toBe(3596);
    expect(patch.tuas_usd).toBe(0);
    expect(patch.subtotal_vuelo_usd).toBe(3100);
    // El T.C. sí se guarda (es lo único que el operador tocó).
    expect(patch.tc_usd_mxn).toBe(16.97);
    // …y la OPERACIÓN no se toca: las columnas del piloto ni siquiera viajan.
    for (const orden of [1, 2]) {
      const esc = w.patchEscala(orden)!;
      expect(esc).not.toHaveProperty('pasajeros');
      expect(esc).not.toHaveProperty('pasajeros_nombres');
      expect(esc).not.toHaveProperty('es_ferry');
      expect(esc).not.toHaveProperty('notas');
      expect(esc).not.toHaveProperty('requiere_pernocta');
      // Lo que SÍ es de la cotización se sigue escribiendo.
      expect(esc.origen_iata).toBe(orden === 1 ? 'CUN' : 'PTU');
      expect(esc.millas_nauticas).toBe(127.5);
    }
    expect((r as { avisos: string[] }).avisos).toEqual([]);
  });

  // La captura del cliente, al centavo: la hoja decía $3,596.00 SIN T.C. y
  // al teclearlo saltaba a $3,712.00. Con T.C. 17 el USD no se mueve y los
  // pesos son exactamente 3,596 × 17 (la #326 no tiene renglones nativos en
  // MXN: TUAS $0 y sin extras — invariante 20).
  it('teclear el T.C. SOLO agrega los pesos: $3,596.00 USD y $61,132.00 MXN', async () => {
    const w = armar();
    await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO', tc_usd_mxn: 17 }),
      USER,
    );
    const patch = w.patchVuelo()!;
    expect(patch.monto_total_usd).toBe(3596);
    expect(patch.monto_total_mxn).toBe(61132);
  });

  it('PANEL VIEJO (sin tramos_base, tramos de la OPERACIÓN): el API ancla a lo cotizado, guarda $3,596.00 y lo DICE en avisos', async () => {
    const w = armar();
    const r = await w.service.revise(
      V326,
      dtoRevision({
        escalas: TRAMOS_OPERACION,
        pasajeros: 4,
        tc_usd_mxn: 16.97,
      }),
      USER,
    );
    const patch = w.patchVuelo()!;
    expect(patch.monto_total_usd).toBe(3596);
    expect(patch.tuas_usd).toBe(0);
    const snap = patch.calculo_snapshot as {
      ruta: { escalas: Array<{ es_ferry: boolean; pasajeros: number }> };
    };
    expect(snap.ruta.escalas[0]).toMatchObject({
      es_ferry: true,
      pasajeros: 0,
    });
    expect(snap.ruta.escalas[1]).toMatchObject({
      es_ferry: false,
      pasajeros: 2,
    });
    expect(w.patchEscala(1)).not.toHaveProperty('pasajeros');
    const avisos = (r as { avisos: string[] }).avisos;
    expect(avisos.some((a) => a.includes('PACTADO'))).toBe(true);
  });

  it('ADOPTAR LA OPERACIÓN (tramos_base OPERACION): $3,712.00 y los 4 pax SÍ se persisten', async () => {
    const w = armar();
    await w.service.revise(
      V326,
      dtoRevision({
        escalas: TRAMOS_OPERACION,
        pasajeros: 4,
        tramos_base: 'OPERACION',
        motivo: 'Actualizar la cotización con la operación',
      }),
      USER,
    );
    const patch = w.patchVuelo()!;
    // TUA CUN $25 × 4 pax = $100 ⇒ IVA 16 % sobre 3,200 = $512.
    expect(patch.tuas_usd).toBe(100);
    expect(patch.monto_total_usd).toBe(3712);
    const esc1 = w.patchEscala(1)!;
    expect(esc1.pasajeros).toBe(4);
    expect(esc1.es_ferry).toBe(false);
  });

  it('EDICIÓN DELIBERADA de la oficina (pax 2→6 en el T2): se escribe en la escala viva', async () => {
    const w = armar();
    await w.service.revise(
      V326,
      dtoRevision({
        tramos_base: 'COTIZADO',
        pasajeros: 6,
        escalas: [
          TRAMOS_COTIZADOS[0],
          { ...TRAMOS_COTIZADOS[1], pasajeros: 6 },
        ],
      }),
      USER,
    );
    expect(w.patchEscala(2)!.pasajeros).toBe(6);
    // El T1 sigue siendo el ferry cotizado: su pax no se toca.
    expect(w.patchEscala(1)).not.toHaveProperty('pasajeros');
  });

  it('el pax del VUELO se deriva de lo COTIZADO, no de lo que voló', async () => {
    const w = armar();
    await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO' }),
      USER,
    );
    expect(w.patchVuelo()!.pasajeros).toBe(2);
  });
});

describe('#326 — ajuste rápido (quickAdjust)', () => {
  it('repreciar por un extra NO arrastra el pax de la operación: sigue en $3,596.00 + el extra', async () => {
    const w = armar();
    await w.service.quickAdjust(
      V326,
      { extras: [{ concepto: 'Handler', monto_usd: 100 }] },
      USER,
    );
    const patch = w.patchVuelo()!;
    expect(patch.tuas_usd).toBe(0);
    // 3,100 + 100 de extra gravado ⇒ IVA 512 ⇒ 3,712 … pero sin TUAS: el
    // extra es lo ÚNICO que se movió (antes el pax del piloto metía $116).
    expect(patch.extras_total_usd).toBe(100);
    expect(patch.monto_total_usd).toBe(3712);
    expect(w.patchEscala(1)).not.toHaveProperty('pasajeros');
    expect(w.patchEscala(2)).not.toHaveProperty('pasajeros');
  });

  it('subir el pax global SÍ es deliberado: se escribe en los tramos que usaban el global', async () => {
    const w = armar();
    await w.service.quickAdjust(V326, { pasajeros: 6 }, USER);
    // El T2 usaba el pax global (2 = vuelo.pasajeros) ⇒ hereda 6.
    expect(w.patchEscala(2)!.pasajeros).toBe(6);
    // El T1 es ferry cotizado: sigue en 0 y no pisa al piloto.
    expect(w.patchEscala(1)).not.toHaveProperty('pasajeros');
  });
});

describe('tramos que la OPERACIÓN cambió de otra forma', () => {
  it('tramo CANCELADO en la operación: la revisión NO lo revive y avisa en ámbar', async () => {
    const w = armar({
      escalas: [
        escalaViva(1),
        escalaViva(2, {
          cancelada_at: '2026-09-20T18:00:00.000Z',
          cancelada_motivo: 'se combinó con otro vuelo',
        }),
      ],
    });
    const r = await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO' }),
      USER,
    );
    expect(w.patchEscala(2)).not.toHaveProperty('cancelada_at');
    const avisos = (r as { avisos: string[] }).avisos;
    expect(avisos.some((a) => a.includes('CANCELADO'))).toBe(true);
  });

  // Casos REALES #322 (T1 CET→PTU, con tacómetro) y #297 (T2 PPS→CZM, con
  // tacómetro): la OPERACIÓN movió la ruta y la oficina NO la tocó en la
  // cotización. Reescribirla desde un ajuste de T.C. falsificaría la
  // bitácora, el calendario y los permisos de un tramo QUE YA VOLÓ.
  it('la RUTA la movió la OPERACIÓN: el vuelo la conserva, la cotización precia con la pactada y AVISA', async () => {
    const w = armar({
      escalas: [
        escalaViva(1, { origen_iata: 'CET' }),
        escalaViva(2, { destino_iata: 'CZM', pasajeros: 4 }),
      ],
    });
    const r = await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO' }),
      USER,
    );
    // El PRECIO sale de lo cotizado (CUN→PTU→CUN), como siempre.
    expect(w.patchVuelo()!.monto_total_usd).toBe(3596);
    for (const orden of [1, 2]) {
      const esc = w.patchEscala(orden)!;
      expect(esc).not.toHaveProperty('origen_iata');
      expect(esc).not.toHaveProperty('destino_iata');
      expect(esc).not.toHaveProperty('millas_nauticas');
      expect(esc).not.toHaveProperty('es_sobrevuelo');
      // …y tampoco se pisa nada más del tramo que la operación movió.
      expect(esc).not.toHaveProperty('pasajeros');
      expect(esc).not.toHaveProperty('es_ferry');
    }
    const avisos = (r as { avisos: string[] }).avisos;
    expect(avisos.some((a) => a.includes('tacómetro'))).toBe(true);
    expect(
      avisos.filter((a) => a.includes('conserva su ruta real')),
    ).toHaveLength(2);
  });

  it('la RUTA la cambió la OFICINA en la cotización: eso SÍ se escribe (tramo redefinido)', async () => {
    const w = armar({
      escalas: [escalaViva(1), escalaViva(2)],
    });
    await w.service.revise(
      V326,
      dtoRevision({
        tramos_base: 'COTIZADO',
        escalas: [
          TRAMOS_COTIZADOS[0],
          { ...TRAMOS_COTIZADOS[1], destino_iata: 'CZM' },
        ],
      }),
      USER,
    );
    const esc2 = w.patchEscala(2)!;
    expect(esc2.destino_iata).toBe('CZM');
    // Ruta redefinida ⇒ el tramo se escribe entero (pax incluido).
    expect(esc2.pasajeros).toBe(2);
    expect(esc2).toHaveProperty('es_sobrevuelo');
    // …y el tramo 1, que nadie tocó, sigue intacto.
    expect(w.patchEscala(1)!).not.toHaveProperty('pasajeros');
  });

  it('ADOPTAR la operación con la ruta movida (tramos_base OPERACION): ahí SÍ manda el DTO', async () => {
    const w = armar({ escalas: [escalaViva(1, { origen_iata: 'CET' })] });
    await w.service.revise(
      V326,
      dtoRevision({
        tramos_base: 'OPERACION',
        escalas: [{ ...TRAMOS_OPERACION[0], origen_iata: 'CET' }],
      }),
      USER,
    );
    expect(w.patchEscala(1)!.origen_iata).toBe('CET');
    expect(w.patchEscala(1)!.pasajeros).toBe(4);
  });

  it('pax de la OPERACIÓN por encima de los asientos: AVISA, no bloquea (caso #319)', async () => {
    const w = armar({
      escalas: [escalaViva(1, { pasajeros: 12 }), escalaViva(2)],
    });
    const r = await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO' }),
      USER,
    );
    const avisos = (r as { avisos: string[] }).avisos;
    expect(avisos.some((a) => a.includes('Capacidad'))).toBe(true);
    // La cotización se guardó igual: un dato operativo no la bloquea.
    expect(w.patchVuelo()!.monto_total_usd).toBe(3596);
  });
});

describe('caminos que NO cambian', () => {
  it('itinerario_operativo = true: replaceEscalas sigue haciendo early-return', async () => {
    const w = armar({ vuelo: vueloRow({ itinerario_operativo: true }) });
    await w.service.revise(V326, dtoRevision(), USER);
    expect(w.patchEscala(1)).toBeNull();
    expect(w.patchEscala(2)).toBeNull();
  });

  it('desde el GRUPO la plantilla manda: escribe pax y ferry en las escalas vivas', async () => {
    const w = armar();
    await w.service.reviseParaGrupo(
      V326,
      dtoRevision({ escalas: TRAMOS_OPERACION, pasajeros: 4 }),
      USER,
      { id: 'g-1', folio: 9, posicion: 1, pax: 4, total_aviones: 2 },
    );
    const esc1 = w.patchEscala(1)!;
    expect(esc1.pasajeros).toBe(4);
    expect(esc1.es_ferry).toBe(false);
  });

  it('cotización SIN snapshot (reserva que se cotiza por primera vez): se escribe todo', async () => {
    const w = armar({ vuelo: vueloRow({ calculo_snapshot: null }) });
    await w.service.revise(
      V326,
      dtoRevision({ escalas: TRAMOS_OPERACION, pasajeros: 4 }),
      USER,
    );
    const esc1 = w.patchEscala(1)!;
    expect(esc1.pasajeros).toBe(4);
    expect(esc1.es_ferry).toBe(false);
  });
});

/**
 * TRAMO DEL CLIENTE AGREGADO DESDE LA OPERACIÓN (30-sep-2026, API 0.0.46,
 * caso #364). Desde el 0.0.46 `POST /flights/:id/operational-legs` crea un
 * tramo con pasajeros como COMERCIAL en el siguiente `orden` (aquí el 3:
 * CUN→HOL con 4 pax, sin tacómetro). La cotización (snapshot de 2 tramos)
 * debe: (a) NO borrarlo al guardar sin adoptarlo, (b) actualizarlo EN SU
 * LUGAR al adoptar la operación —UPSERT por `orden`, sin duplicarlo—.
 */
describe('#364 — tramo del cliente que agregó la operación', () => {
  const tramo3Vivo = escalaViva(3, {
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    pasajeros: 4,
    notas: null,
    fecha_salida_plan: null,
    taco_salida: null,
    taco_llegada: null,
    google_calendar_id: 'g-e3',
  });
  const escalas364 = () => [escalaViva(1), escalaViva(2), tramo3Vivo];
  const tramo3 = {
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    millas_nauticas: 25,
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
  };
  const borrados = (log: Op[]) =>
    log.filter((o) => o.tabla === 'escala' && o.tipo === 'delete');
  const insertados = (log: Op[]) =>
    log.filter((o) => o.tabla === 'escala' && o.tipo === 'insert');

  it('guardar SIN adoptar (un ajuste cualquiera): el tramo 3 NO se borra y la respuesta lo AVISA', async () => {
    const w = armar({ escalas: escalas364() });
    const r = await w.service.revise(
      V326,
      dtoRevision({ tramos_base: 'COTIZADO' }),
      USER,
    );
    expect(borrados(w.log)).toHaveLength(0);
    expect(w.patchEscala(3)).toBeNull();
    const avisos = (r as { avisos: string[] }).avisos;
    expect(
      avisos.some(
        (a) =>
          a.includes('El tramo 3 CUN → HOL') &&
          a.includes('lo agregó la operación'),
      ),
    ).toBe(true);
    // El precio sigue siendo el PACTADO.
    expect(w.patchVuelo()!.monto_total_usd).toBe(3596);
  });

  it('panel VIEJO (sin tramos_base): tampoco lo borra', async () => {
    const w = armar({ escalas: escalas364() });
    await w.service.revise(V326, dtoRevision(), USER);
    expect(borrados(w.log)).toHaveLength(0);
  });

  it('ADOPTAR la operación (3 tramos): UPSERT por orden — actualiza el tramo 3 en su lugar, sin insertar otro', async () => {
    const w = armar({ escalas: escalas364() });
    await w.service.revise(
      V326,
      dtoRevision({
        escalas: [...TRAMOS_OPERACION, tramo3],
        pasajeros: 4,
        tramos_base: 'OPERACION',
        motivo: 'Actualizar la cotización con la operación',
      }),
      USER,
    );
    expect(insertados(w.log)).toHaveLength(0);
    expect(borrados(w.log)).toHaveLength(0);
    const esc3 = w.patchEscala(3)!;
    expect(esc3).not.toBeNull();
    expect(esc3.pasajeros).toBe(4);
    // El snapshot nuevo ya trae los 3 tramos.
    const snap = w.patchVuelo()!.calculo_snapshot as {
      ruta: { escalas: unknown[] };
    };
    expect(snap.ruta.escalas).toHaveLength(3);
  });

  it('desde el GRUPO (re-materializar la plantilla): el tramo que la operación agregó a ESTE hijo NO se borra', async () => {
    // Revisión adversaria 30-sep-2026: el grupo confía en su DTO para las
    // columnas, pero su plantilla no conoce el tramo 3 — tratarla como «la
    // lista completa» lo BORRABA (con evento de Google y push) cada vez que
    // alguien editaba el grupo.
    const w = armar({ escalas: escalas364() });
    const r = await w.service.reviseParaGrupo(
      V326,
      dtoRevision({ escalas: TRAMOS_OPERACION, pasajeros: 4 }),
      USER,
      { id: 'g-1', folio: 9, posicion: 1, pax: 4, total_aviones: 2 },
    );
    expect(borrados(w.log)).toHaveLength(0);
    expect(w.patchEscala(3)).toBeNull();
    // La plantilla sí manda en los tramos que el grupo cotizó.
    expect(w.patchEscala(1)!.pasajeros).toBe(4);
    const avisos = (r as { avisos: string[] }).avisos;
    expect(avisos.some((a) => a.includes('El tramo 3 CUN → HOL'))).toBe(true);
  });

  it('ADOPTAR la operación sigue mandando su lista: un sobrante no cotizado que la operación CANCELÓ se borra', async () => {
    const w = armar({
      escalas: [
        escalaViva(1),
        escalaViva(2),
        { ...tramo3Vivo, cancelada_at: '2026-09-30T15:00:00Z' },
      ],
    });
    await w.service.revise(
      V326,
      dtoRevision({
        escalas: TRAMOS_OPERACION,
        pasajeros: 4,
        tramos_base: 'OPERACION',
        motivo: 'Actualizar la cotización con la operación',
      }),
      USER,
    );
    const b = borrados(w.log);
    expect(b).toHaveLength(1);
    expect(b[0].filtros.some((f) => f[1] === 'id' && f[2] === 'e3')).toBe(true);
  });

  it('CONTROL: un tramo que SÍ estaba cotizado y la oficina quitó se sigue borrando (edición deliberada)', async () => {
    const w = armar({
      escalas: [
        escalaViva(1),
        escalaViva(2, { taco_salida: null, taco_llegada: null }),
      ],
    });
    await w.service.revise(
      V326,
      dtoRevision({
        escalas: [TRAMOS_COTIZADOS[0]],
        tramos_base: 'COTIZADO',
      }),
      USER,
    );
    const b = borrados(w.log);
    expect(b).toHaveLength(1);
    expect(b[0].filtros.some((f) => f[1] === 'id' && f[2] === 'e2')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// «PASAR ESTOS TRAMOS AL VUELO» (17-nov-2026, API 0.0.141, invariante 136)
//
// Caso REAL #478 (lectura de prod del 17-nov-2026): nació el 23-oct como
// RESERVA con UN tramo CUN → MHL de 0 pasajeros (`itinerario_operativo =
// true`); el 17-nov la oficina lo cotizó CUN → CTM → MHL → CTM → CUN (v3,
// $6,156.83) y el vuelo siguió con su único tramo: «no salen los demás
// tramos y no se actualiza a lo que acabo de poner en la cotización».
// ───────────────────────────────────────────────────────────────────────────
describe('pasarTramosAlVuelo — la ruta de la cotización pasa a ser la del vuelo (caso #478)', () => {
  const SNAP_478 = [
    tramoSnapshot(1, {
      origen_iata: 'CUN',
      destino_iata: 'CTM',
      pasajeros: 4,
      es_ferry: false,
      millas_nauticas: 173,
      fecha_salida_plan: '2026-11-18T15:00:00.000Z',
    }),
    tramoSnapshot(2, {
      origen_iata: 'CTM',
      destino_iata: 'MHL',
      pasajeros: 6,
      es_ferry: false,
      millas_nauticas: 38.82,
      fecha_salida_plan: '2026-11-18T17:00:00.000Z',
    }),
    tramoSnapshot(3, {
      origen_iata: 'MHL',
      destino_iata: 'CTM',
      pasajeros: 2,
      es_ferry: false,
      millas_nauticas: 38.82,
    }),
    tramoSnapshot(4, {
      origen_iata: 'CTM',
      destino_iata: 'CUN',
      pasajeros: 0,
      es_ferry: true,
      millas_nauticas: 173,
    }),
  ];

  /** La escala de la RESERVA: CUN → MHL, 0 pax, 08:00, sin tacómetro. */
  const escalaReserva = (extra: Row = {}) =>
    escalaViva(1, {
      origen_iata: 'CUN',
      destino_iata: 'MHL',
      pasajeros: 0,
      millas_nauticas: null,
      taco_salida: null,
      taco_llegada: null,
      fecha_salida_plan: '2026-11-18T13:00:00+00:00',
      notas: '',
      piloto_id: 'p-pablo',
      ...extra,
    });

  function mundo478(extraVuelo: Row = {}, escalas?: Row[]) {
    const m = armar({
      vivo: true,
      vuelo: vueloRow({
        folio: 478,
        estado: 'CONFIRMADO',
        itinerario_operativo: true,
        cotizacion_version: 3,
        fecha_vuelo: '2026-11-18T13:00:00+00:00',
        fecha_traslado_final: null,
        notas_internas: 'Horario tentativo',
        combinado_con_id: null,
        grupo_id: null,
        monto_total_usd: 6156.83,
        calculo_snapshot: {
          ruta: { escalas: SNAP_478 },
          totales: { total_usd: 6156.83 },
        },
        ...extraVuelo,
      }),
      escalas: escalas ?? [escalaReserva()],
    });
    const interno = m.service as unknown as {
      notificarTripulacion: (...a: unknown[]) => Promise<void>;
      replaceEscalas: (...a: unknown[]) => Promise<string[]>;
    };
    const avisar = jest
      .spyOn(interno, 'notificarTripulacion')
      .mockResolvedValue(undefined);
    // El aviso lee el vuelo completo; aquí basta con su id y su folio.
    jest
      .spyOn(m.service, 'findById')
      .mockResolvedValue({ id: V326, folio: 478 } as never);
    const escrituras = () => m.log.filter((o) => o.tipo !== 'select');
    const porOrden = () =>
      [...m.escalas].sort((a, b) => Number(a.orden) - Number(b.orden));
    return { ...m, interno, avisar, escrituras, porOrden };
  }

  const codigoDe = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      const r = (e as { response?: { error?: string } }).response;
      return r?.error ?? `sin código: ${String(e)}`;
    }
  };

  it('#478: el vuelo queda con los CUATRO tramos cotizados, con sus pasajeros y sus horas', async () => {
    const m = mundo478();
    const r = await m.service.pasarTramosAlVuelo(V326, USER);

    expect(r).toMatchObject({
      ok: true,
      vuelo_id: V326,
      folio: 478,
      tramos: 4,
      ruta: 'CUN → CTM → MHL → CTM → CUN',
      ruta_anterior: 'CUN → MHL',
    });
    // El vuelo deja de ser «ruta operativa»: desde aquí sigue la cotización.
    expect(m.vuelo.itinerario_operativo).toBe(false);
    expect(
      m
        .porOrden()
        .map(
          (e) =>
            `${String(e.orden)}:${String(e.origen_iata)}-${String(e.destino_iata)}:${String(e.pasajeros)}:${e.es_ferry === true ? 'ferry' : 'pax'}`,
        ),
    ).toEqual([
      '1:CUN-CTM:4:pax',
      '2:CTM-MHL:6:pax',
      '3:MHL-CTM:2:pax',
      '4:CTM-CUN:0:ferry',
    ]);
    // La hora de cada tramo es la que la oficina guardó en la cotización.
    expect(m.porOrden().map((e) => e.fecha_salida_plan)).toEqual([
      '2026-11-18T15:00:00.000Z',
      '2026-11-18T17:00:00.000Z',
      null,
      null,
    ]);
    expect(m.porOrden().map((e) => e.millas_nauticas)).toEqual([
      173, 38.82, 38.82, 173,
    ]);
  });

  it('el tramo 1 se ACTUALIZA en su lugar (mismo id, mismo piloto): no se borra y se vuelve a crear', async () => {
    const m = mundo478();
    await m.service.pasarTramosAlVuelo(V326, USER);
    const t1 = m.porOrden()[0];
    expect(t1.id).toBe('e1');
    expect(t1.piloto_id).toBe('p-pablo');
    expect(t1.aeronave_id).toBe(N621TX);
    // Los tres nuevos nacen SIN piloto ni avión propios: heredan los del vuelo.
    for (const e of m.porOrden().slice(1)) {
      expect(e.piloto_id).toBeUndefined();
      expect(e.aeronave_id).toBeUndefined();
    }
    expect(
      m.log.filter((o) => o.tabla === 'escala' && o.tipo === 'delete'),
    ).toHaveLength(0);
  });

  it('NO es una revisión: ni el precio, ni el snapshot, ni la versión se tocan', async () => {
    const m = mundo478();
    await m.service.pasarTramosAlVuelo(V326, USER);
    const tocadas = new Set(
      m.log
        .filter((o) => o.tabla === 'vuelo' && o.tipo === 'update')
        .flatMap((o) => Object.keys(o.payload ?? {})),
    );
    expect([...tocadas].sort()).toEqual([
      'itinerario_operativo',
      'notas_internas',
      'updated_by',
    ]);
    expect(m.vuelo.monto_total_usd).toBe(6156.83);
    expect(m.vuelo.cotizacion_version).toBe(3);
    expect(
      m.log.some(
        (o) => o.tabla === 'cotizacion_version_history' && o.tipo === 'insert',
      ),
    ).toBe(false);
  });

  it('re-deriva los permisos de pista, sella quién y cuándo, y avisa UNA vez a la tripulación', async () => {
    const m = mundo478();
    const r = await m.service.pasarTramosAlVuelo(V326, USER);
    expect(m.refreshPermisos).toHaveBeenCalledTimes(1);
    expect(m.refreshPermisos).toHaveBeenCalledWith(V326);
    // La nota que ya había se conserva; el sello va debajo.
    const notas = String(m.vuelo.notas_internas);
    expect(
      notas.startsWith(
        'Horario tentativo\n[Tramos de la cotización al vuelo] ',
      ),
    ).toBe(true);
    expect(notas).toContain(
      'el vuelo tomó los tramos de la cotización v3 (CUN → CTM → MHL → CTM → CUN); antes tenía CUN → MHL.',
    );
    expect(m.avisar).toHaveBeenCalledTimes(1);
    expect(m.avisar.mock.calls[0][1]).toEqual({
      titulo: 'Vuelo #478: cambió el itinerario',
      cuerpo:
        'Ahora es CUN → CTM → MHL → CTM → CUN (antes CUN → MHL). Revisa tus tramos y horarios.',
    });
    // El vuelo decía 08:00 y la cotización 10:00: se AVISA, no se decide.
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toContain('18/11/2026 10:00');
    expect(r.avisos[0]).toContain('18/11/2026 08:00');
  });

  it('pulsarlo dos veces: la segunda responde «ya sigue la cotización» y no escribe nada', async () => {
    const m = mundo478();
    await m.service.pasarTramosAlVuelo(V326, USER);
    const antes = m.escrituras().length;
    expect(await codigoDe(m.service.pasarTramosAlVuelo(V326, USER))).toBe(
      'VUELO_YA_SIGUE_COTIZACION',
    );
    expect(m.escrituras()).toHaveLength(antes);
    expect(m.escalas).toHaveLength(4);
  });

  it.each([
    ['cancelado', { estado: 'CANCELADO' }, undefined, 'VUELO_CANCELADO'],
    ['en vuelo', { estado: 'EN_VUELO' }, undefined, 'VUELO_YA_VOLO'],
    ['completado', { estado: 'COMPLETADO' }, undefined, 'VUELO_YA_VOLO'],
    [
      'con un tacómetro capturado',
      {},
      [escalaReserva({ taco_salida: 5599.4 })],
      'VUELO_YA_VOLO',
    ],
    [
      'combinado con otro vuelo',
      { combinado_con_id: 'otro' },
      undefined,
      'VUELO_COMBINADO',
    ],
    ['avión de un grupo', { grupo_id: 'g-12' }, undefined, 'VUELO_DE_GRUPO'],
    [
      'sin tramos cotizados',
      { calculo_snapshot: { ruta: { escalas: [] } } },
      undefined,
      'SIN_TRAMOS_COTIZADOS',
    ],
    [
      'que ya sigue la cotización',
      { itinerario_operativo: false },
      undefined,
      'VUELO_YA_SIGUE_COTIZACION',
    ],
  ] as Array<[string, Row, Row[] | undefined, string]>)(
    'vuelo %s: 409 con su código y NADA escrito',
    async (_caso, extraVuelo, escalas, codigo) => {
      const m = mundo478(extraVuelo, escalas);
      expect(await codigoDe(m.service.pasarTramosAlVuelo(V326, USER))).toBe(
        codigo,
      );
      expect(m.escrituras()).toHaveLength(0);
      expect(m.avisar).not.toHaveBeenCalled();
      expect(m.refreshPermisos).not.toHaveBeenCalled();
    },
  );

  it('la cotización tiene MENOS tramos que el vuelo: el sobrante se borra y su piloto recibe aviso directo', async () => {
    const m = mundo478(
      {
        calculo_snapshot: {
          ruta: { escalas: [SNAP_478[0], SNAP_478[3]] },
          totales: { total_usd: 4040.22 },
        },
      },
      [
        escalaReserva(),
        escalaViva(2, {
          origen_iata: 'MHL',
          destino_iata: 'CZM',
          pasajeros: 0,
          taco_salida: null,
          taco_llegada: null,
        }),
        escalaViva(3, {
          origen_iata: 'CZM',
          destino_iata: 'CUN',
          pasajeros: 0,
          taco_salida: null,
          taco_llegada: null,
          piloto_id: 'p-otro',
        }),
      ],
    );
    const r = await m.service.pasarTramosAlVuelo(V326, USER);
    expect(r.ruta_anterior).toBe('CUN → MHL → CZM → CUN');
    expect(
      m
        .porOrden()
        .map((e) => `${String(e.origen_iata)}-${String(e.destino_iata)}`),
    ).toEqual(['CUN-CTM', 'CTM-CUN']);
    const directos = (
      m.notifyUser.mock.calls as Array<[string, Record<string, unknown>]>
    ).filter((c) => c[0] === 'p-otro');
    expect(directos).toHaveLength(1);
    expect(directos[0][1]).toMatchObject({
      titulo: 'Tramo eliminado · vuelo #478',
      cuerpo:
        'El tramo CZM → CUN que tenías asignado se eliminó: el vuelo tomó los tramos de la cotización.',
    });
  });

  it('si la escritura de tramos FALLA, la bandera regresa (el botón se puede repetir) y responde 503', async () => {
    const m = mundo478();
    jest
      .spyOn(m.interno, 'replaceEscalas')
      .mockRejectedValue(new Error('boom'));
    expect(await codigoDe(m.service.pasarTramosAlVuelo(V326, USER))).toBe(
      'TRAMOS_NO_ESCRITOS',
    );
    expect(m.vuelo.itinerario_operativo).toBe(true);
    expect(m.refreshPermisos).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
    expect(String(m.vuelo.notas_internas)).toBe('Horario tentativo');
  });

  it('la ruta es de quien GUARDA la cotización: ADMIN y COORDINADOR (Dirección pasa el guard)', () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        // Del descriptor: leer el método del prototipo lo desligaría.
        Object.getOwnPropertyDescriptor(
          QuotesController.prototype,
          'pasarTramosAlVuelo',
        )?.value as object,
      ),
    ).toEqual([Rol.ADMIN, Rol.COORDINADOR]);
  });
});
