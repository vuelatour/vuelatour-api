// Módulos pesados que quotes.service importa solo para inyección: se
// sustituyen por clases vacías — notifications arrastra el gateway y `jose`
// (ESM puro), calendar-sync googleapis.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { QuotesService, type GrupoHijoOpts } from './quotes.service';
import { MetodoPago, TipoTarifa, TipoVuelo } from './dto/calculate-quote.dto';
import type { ReviseQuoteDto } from './dto/revise-quote.dto';
import type { PreviewQuoteDto } from './dto/preview-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { FlightsService } from '../flights/flights.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';

/**
 * COTIZACIÓN #338 CON LOS DATOS REALES DE PRODUCCIÓN (revisión adversaria
 * 24-sep-2026). Leídos en solo lectura de `bjesduasnzbzywofukbf`:
 *
 * - vuelo 00a22981…a1ad, folio 338, COMPLETADO, `itinerario_operativo`
 *   true, piloto fdf7f95a… y copiloto 66d3af02… a nivel vuelo,
 *   `fecha_vuelo` 2026-09-24T13:30Z (8:30 Cancún), `fecha_traslado_final`
 *   null ANTES de la v2.
 * - tramo 1 CUN→PTU ferry `solo_operativa`, N4142R, tacos 4460.5→4461.7
 *   (PILOTO); tramo 2 PTU→CUN 1 pax, N4142R, 4461.7 (DEDUCIDO)→4462.9.
 * - v2 (cotizacion_version_history, 17:54Z): Cessna 206 XA-VGV, tarifa
 *   manual $600, pactado 2.4 h, comisión FIJA $350 (Pablo Canales), IVA 16 %
 *   ⇒ subtotal $1,440.00 · IVA $286.40 · total $2,076.40; motivo «[Fecha
 *   traslado final —→24 sep 10:00 · Avión PIPER SENECA V→Cessna 206 ·
 *   Tarifa/hr manual $600 · Cobrable pactado —→2.4 hr · +5 más] Corrección».
 * - Lo que salió en `notificacion` a las 17:54Z: «Vuelo #338 reagendado · el
 *   REGRESO ahora sale 24/09/26, 10:00» y «Vuelo #338: cambio de avión ·
 *   Ahora vuela en XA-VGV», a piloto Y copiloto (cuatro push de un vuelo que
 *   había aterrizado a las ~11:00).
 * - La v1 NO está en el historial (se sobrescribió): su snapshot se
 *   reconstruye con la ficha REAL de N4142R (Piper Seneca V, tarifa pública
 *   $1,050) — el motivo de la v2 confirma «Avión PIPER SENECA V→…».
 *
 * Se corre `revise` con Supabase simulado (estado en memoria) y se exige:
 * cabecera y tramos intactos, CERO notificaciones, `avisos[]` con el texto
 * único y el precio EXACTO de la v2 de prod calculado con el Cessna.
 */
type Row = Record<string, unknown>;

const VUELO = '00a22981-e768-4455-9fc1-ecec8ab6a1ad';
const CLIENTE = 'beabddc5-ab46-412d-aca7-92def34babb0';
const PILOTO = 'fdf7f95a-6e7b-4cfb-8167-c4b85454d4dd';
const COPILOTO = '66d3af02-1d4f-4a7f-8d78-155751a8dae0';
const N4142R = '5a82eb4a-086c-4058-97bd-b2aacdc2e942';
const XAVGV = '3d0546c3-941f-45cc-b8a9-e3ee77545e68';
const USER = 'uuuuuuuu-0000-4000-8000-0000000000f1';

/** Fichas REALES del catálogo (prod, 24-sep-2026). */
const FICHAS: Record<string, Row> = {
  [N4142R]: {
    id: N4142R,
    activa: true,
    matricula: 'N4142R',
    modelo: 'PIPER SENECA V',
    pais_registro: 'USA',
    velocidad_crucero_kts: 150,
    tarifa_hora_pub_usd: 1050,
    tarifa_hora_broker_usd: 950,
    asientos: 5,
  },
  [XAVGV]: {
    id: XAVGV,
    activa: true,
    matricula: 'XA-VGV',
    modelo: 'Cessna 206',
    pais_registro: 'MX',
    velocidad_crucero_kts: 120,
    tarifa_hora_pub_usd: 750,
    tarifa_hora_broker_usd: 650,
    asientos: 5,
  },
};

/** Ruta cotizada (idéntica en v1 y v2: `calculo_snapshot.ruta.escalas`). */
const RUTA = [
  {
    origen_iata: 'CUN',
    destino_iata: 'PTU',
    millas_nauticas: 125,
    pasajeros: 0,
    es_ferry: true,
  },
  {
    origen_iata: 'PTU',
    destino_iata: 'CUN',
    millas_nauticas: 125,
    pasajeros: 1,
    es_ferry: false,
  },
];

/** Snapshot v1 (reconstruido: Seneca N4142R con tarifa pública). */
function snapshotV1(): Row {
  return {
    aeronave: {
      id: N4142R,
      modelo: 'PIPER SENECA V',
      matricula: 'N4142R',
      pais_registro: 'USA',
      velocidad_crucero_kts: 150,
    },
    tarifa: {
      tipo: 'PUBLICO',
      usd_por_hora: 1050,
      preferencial_cliente: false,
      proviene_de_override: false,
    },
    ruta: {
      id: null,
      origen_iata: 'CUN',
      destino_iata: 'CUN',
      es_redondo_auto: false,
      num_aterrizajes: 2,
      escalas: RUTA.map((e) => ({
        ...e,
        notas: null,
        pdf_oculto: null,
        tipo_parada: 'NORMAL',
        servicio_notas: null,
        fecha_salida_plan: null,
        pasajeros_nombres: [],
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
      })),
    },
    meta: { comision_vendedor_modo: 'FIJA', comision_vendedor_usd: 350 },
  };
}

interface Estado {
  estado?: string;
  cabecera?: string;
  /** false = tramos SIN tacómetro (control: vuelo que aún no vuela). */
  tacos?: boolean;
  /** Tacos solo en el tramo 1 (viaje a medio camino). */
  soloTramo1?: boolean;
  calculo_snapshot?: Row;
  fecha_traslado_final?: string | null;
  /**
   * false = variante con `itinerario_operativo = false` y el tramo 1
   * comercial (no solo-operativo): así `replaceEscalas` sí escribe tramos.
   */
  itinerarioOperativo?: boolean;
}

function mundo(e: Estado = {}) {
  const tacos = e.tacos !== false;
  const vuelo: Row = {
    id: VUELO,
    folio: 338,
    cliente_id: CLIENTE,
    aeronave_id: e.cabecera ?? N4142R,
    piloto_id: PILOTO,
    copiloto_id: COPILOTO,
    apoyo_id: null,
    estado: e.estado ?? 'COMPLETADO',
    es_externo: false,
    tipo: 'MULTIESCALA',
    cotizacion_version: 1,
    facturado: false,
    cobrado: false,
    itinerario_operativo: e.itinerarioOperativo !== false,
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    pasajeros: 1,
    monto_total_usd: 2976,
    tc_usd_mxn: null,
    metodo_cobro: 'TRANSFERENCIA',
    comision_vendedor_usd: 350,
    comision_vendedor_modo: 'FIJA',
    comision_vendedor_nombre: 'Pablo Canales',
    comision_vendedor_tarifa_hr: null,
    fecha_vuelo: '2026-09-24T13:30:00+00:00',
    fecha_traslado_final:
      e.fecha_traslado_final === undefined ? null : e.fecha_traslado_final,
    fecha_fin: '2026-09-24T15:00:00+00:00',
    extras: [],
    notas: null,
    calculo_snapshot: e.calculo_snapshot ?? snapshotV1(),
  };
  const escalas: Row[] = [
    {
      id: '68ef505f-56a8-43be-bd40-034ea7b473aa',
      vuelo_id: VUELO,
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'PTU',
      aeronave_id: N4142R,
      piloto_id: PILOTO,
      copiloto_id: null,
      millas_nauticas: null,
      pasajeros: 0,
      es_ferry: true,
      solo_operativa: e.itinerarioOperativo !== false,
      cancelada_at: null,
      taco_salida: tacos ? 4460.5 : null,
      taco_llegada: tacos ? 4461.7 : null,
      fecha_salida_plan: '2026-09-24T13:30:00+00:00',
      requiere_pernocta: false,
      tipo_parada: 'NORMAL',
    },
    {
      id: '8ab25208-ab97-468a-b531-f1a89638234b',
      vuelo_id: VUELO,
      orden: 2,
      origen_iata: 'PTU',
      destino_iata: 'CUN',
      aeronave_id: N4142R,
      piloto_id: PILOTO,
      copiloto_id: null,
      millas_nauticas: null,
      pasajeros: 1,
      es_ferry: false,
      solo_operativa: false,
      cancelada_at: null,
      taco_salida: tacos && !e.soloTramo1 ? 4461.7 : null,
      taco_llegada: tacos && !e.soloTramo1 ? 4462.9 : null,
      fecha_salida_plan: '2026-09-24T15:00:00+00:00',
      requiere_pernocta: false,
      tipo_parada: 'NORMAL',
    },
  ];
  const updates: { tabla: string; patch: Row; id?: unknown }[] = [];
  const inserts: { tabla: string; fila: Row }[] = [];

  const supabase = {
    service: {
      from(tabla: string) {
        const ops: { m: string; args: unknown[] }[] = [];
        const q: Record<string, unknown> = {};
        const filtra = (rows: Row[]): Row[] =>
          rows.filter((r) =>
            ops.every((o) => {
              if (o.m === 'eq') {
                const [col, val] = o.args as [string, unknown];
                // Columnas de embeds (tarifas.aeronave_id) no se filtran.
                return col.includes('.') || !(col in r) || r[col] === val;
              }
              if (o.m === 'is') {
                const [col, val] = o.args as [string, unknown];
                return !(col in r) || r[col] === val;
              }
              return true;
            }),
          );
        const resolve = (lista: boolean): Row => {
          const upd = ops.find((o) => o.m === 'update');
          const ins = ops.find((o) => o.m === 'insert');
          if (upd)
            updates.push({
              tabla,
              patch: upd.args[0] as Row,
              id: ops.find((o) => o.m === 'eq' && o.args[0] === 'id')?.args[1],
            });
          if (ins) inserts.push({ tabla, fila: ins.args[0] as Row });
          if (tabla === 'vuelo') {
            if (upd) {
              Object.assign(vuelo, upd.args[0] as Row);
              return { data: { ...vuelo } };
            }
            return lista ? { data: [{ ...vuelo }] } : { data: { ...vuelo } };
          }
          if (tabla === 'escala') {
            if (upd || ins) return { data: lista ? [] : null };
            const filas = filtra(escalas).map((r) => ({ ...r }));
            return lista ? { data: filas } : { data: filas[0] ?? null };
          }
          if (tabla === 'aeronave') {
            const inIds = ops.find((o) => o.m === 'in')?.args[1] as
              | string[]
              | undefined;
            const eqId = ops.find((o) => o.m === 'eq')?.args[1] as
              | string
              | undefined;
            const ids = inIds ?? (eqId ? [eqId] : []);
            const filas = ids.map((id) => FICHAS[id]).filter(Boolean);
            return lista ? { data: filas } : { data: filas[0] ?? null };
          }
          if (tabla === 'cliente') {
            return { data: { es_interno: false, tarifas: [] } };
          }
          return lista ? { data: [] } : { data: null };
        };
        for (const met of [
          'select',
          'eq',
          'neq',
          'in',
          'is',
          'not',
          'or',
          'gte',
          'lte',
          'lt',
          'gt',
          'order',
          'limit',
          'range',
          'insert',
          'update',
          'delete',
        ]) {
          q[met] = (...args: unknown[]) => {
            ops.push({ m: met, args });
            return q;
          };
        }
        q.maybeSingle = () =>
          Promise.resolve({ ...resolve(false), error: null });
        q.single = () => Promise.resolve({ ...resolve(false), error: null });
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ ...resolve(true), error: null }).then(res);
        return q;
      },
    },
  } as unknown as SupabaseService;

  const aircraft = {
    findById: jest.fn((id: string) => Promise.resolve(FICHAS[id])),
  } as unknown as AircraftService;
  const airports = {
    // TUAS reales del #338: aplica pero en $0/pax (tuas.total_usd = 0).
    computeTuasUsdPax: jest
      .fn()
      .mockResolvedValue({ aplica: true, usd_pax: 0, razon: 'TUAS aplica' }),
    refreshPermisosDeVuelo: jest.fn().mockResolvedValue(false),
  } as unknown as AirportsService;
  const validateAssignTargets = jest.fn(() =>
    Promise.resolve({ squawksAceptados: [], avisos: [] }),
  );
  const notificarSquawkAceptado = jest.fn();
  const flights = {
    validateAssignTargets,
    notificarSquawkAceptado,
    avisoTallerDe: jest.fn(() => Promise.resolve([])),
  } as unknown as FlightsService;
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifyRole = jest.fn().mockResolvedValue(true);
  const syncFlight = jest.fn();
  const service = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    { syncFlight } as unknown as CalendarSyncService,
    {} as EmailService,
    { notifyUser, notifyRole } as unknown as NotificationsService,
    flights,
  );
  const patchVuelo = () =>
    updates.find((u) => u.tabla === 'vuelo' && 'cotizacion_version' in u.patch)
      ?.patch ?? null;
  const escalaConAvion = () =>
    updates.filter((u) => u.tabla === 'escala' && 'aeronave_id' in u.patch);
  return {
    service,
    vuelo,
    updates,
    inserts,
    patchVuelo,
    escalaConAvion,
    validateAssignTargets,
    notificarSquawkAceptado,
    notifyUser,
    notifyRole,
  };
}

/** DTO de la v2 tal como lo reconstruye su snapshot persistido en prod. */
function dtoV2(extra: Partial<ReviseQuoteDto> = {}): ReviseQuoteDto {
  return {
    aeronave_id: XAVGV,
    cliente_id: CLIENTE,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: RUTA.map((e) => ({ ...e })),
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 1,
    metodo_pago: MetodoPago.TRANSFERENCIA,
    tarifa_hora_override_usd: 600,
    tiempo_cobrable_override_hr: 2.4,
    comision_vendedor_usd: 350,
    comision_vendedor_modo: 'FIJA',
    comision_vendedor_nombre: 'Pablo Canales',
    fecha_vuelo: new Date('2026-09-24T13:30:00.000Z'),
    fecha_traslado_final: new Date('2026-09-24T15:00:00.000Z'),
    motivo:
      '[Fecha traslado final —→24 sep 10:00 · Avión PIPER SENECA V→Cessna 206 · Tarifa/hr manual $600 · Cobrable pactado —→2.4 hr · +5 más] Corrección',
    ...extra,
  };
}

/** Los avisos a tripulación son `void` (best-effort): se drenan. */
const drenar = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const titulos = (w: ReturnType<typeof mundo>) =>
  (w.notifyUser.mock.calls as unknown[][]).map(
    (c) => (c[1] as { titulo?: string } | undefined)?.titulo ?? '',
  );

const AVISO_338 =
  'El vuelo ya voló en N4142R: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.';

describe('#338 con datos REALES de prod — revise de la v2 sobre el vuelo COMPLETADO', () => {
  it('vuelo.aeronave_id NO cambia (N4142R) y ningún tramo cambia de avión', async () => {
    const w = mundo();
    await w.service.revise(VUELO, dtoV2(), USER);
    await drenar();
    expect(w.patchVuelo()!.aeronave_id).toBe(N4142R);
    expect(w.vuelo.aeronave_id).toBe(N4142R);
    expect(w.escalaConAvion()).toEqual([]);
    // itinerario_operativo = true ⇒ replaceEscalas no toca NADA de la escala.
    expect(w.updates.filter((u) => u.tabla === 'escala')).toEqual([]);
  });

  it('CERO notificaciones (ni «cambio de avión» ni «el REGRESO ahora sale…», ni al mecánico)', async () => {
    const w = mundo();
    await w.service.revise(VUELO, dtoV2(), USER);
    await drenar();
    expect(w.notifyUser).not.toHaveBeenCalled();
    expect(w.notifyRole).not.toHaveBeenCalled();
    expect(w.notificarSquawkAceptado).not.toHaveBeenCalled();
  });

  it('no es una asignación: no pasa por el pre-check de squawk/taller', async () => {
    const w = mundo();
    await w.service.revise(VUELO, dtoV2(), USER);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
  });

  it('avisos[] trae el texto único del cambio solo comercial', async () => {
    const w = mundo();
    const res = (await w.service.revise(VUELO, dtoV2(), USER)) as {
      avisos: string[];
    };
    expect(res.avisos).toContain(AVISO_338);
  });

  it('el PRECIO se calcula con el Cessna 206 y reproduce EXACTO la v2 de prod ($1,440.00 · IVA $286.40 · $2,076.40)', async () => {
    const w = mundo();
    await w.service.revise(VUELO, dtoV2(), USER);
    const p = w.patchVuelo()!;
    const snap = p.calculo_snapshot as {
      aeronave: { id: string; modelo: string; matricula: string };
      tarifa: { usd_por_hora: number };
      tiempos: { cobrable_hr: number };
      totales: {
        subtotal_vuelo_usd: number;
        iva_usd: number;
        total_usd: number;
      };
    };
    expect(snap.aeronave).toMatchObject({
      id: XAVGV,
      matricula: 'XA-VGV',
      modelo: 'Cessna 206',
    });
    expect(snap.tarifa.usd_por_hora).toBe(600);
    expect(snap.tiempos.cobrable_hr).toBe(2.4);
    expect(snap.totales).toMatchObject({
      subtotal_vuelo_usd: 1440,
      iva_usd: 286.4,
      total_usd: 2076.4,
    });
    expect(p.monto_total_usd).toBe(2076.4);
    const hist = w.inserts.find(
      (i) => i.tabla === 'cotizacion_version_history',
    )!;
    expect(hist.fila).toMatchObject({
      version: 2,
      aeronave_id: XAVGV,
      monto_total_usd: 2076.4,
    });
  });

  it('las fechas del vuelo no se reescriben (calendario / fecha_fin / mes del dinero) y se avisa del regreso conservado', async () => {
    const w = mundo();
    const res = (await w.service.revise(VUELO, dtoV2(), USER)) as {
      avisos: string[];
    };
    const p = w.patchVuelo()!;
    expect('fecha_vuelo' in p).toBe(false);
    expect('fecha_traslado_final' in p).toBe(false);
    expect(w.vuelo.fecha_traslado_final).toBeNull();
    // La salida del DTO es la MISMA que la del vuelo ⇒ nada que avisar de ella.
    expect(res.avisos.join(' ')).not.toMatch(/fecha de salida/);
    expect(res.avisos).toContain(
      'El viaje ya terminó: la fecha de regreso no se cambia desde la cotización (movería el calendario); el vuelo se queda sin fecha de regreso.',
    );
  });

  it('estado de prod ANTES de la corrección manual (cabecera XA-VGV, tramos N4142R): guardar la regresa a N4142R, sin push', async () => {
    const snapV2 = {
      ...snapshotV1(),
      aeronave: {
        id: XAVGV,
        modelo: 'Cessna 206',
        matricula: 'XA-VGV',
        pais_registro: 'MX',
        velocidad_crucero_kts: 120,
      },
    };
    const w = mundo({
      cabecera: XAVGV,
      calculo_snapshot: snapV2,
      fecha_traslado_final: '2026-09-24T15:00:00+00:00',
    });
    const res = (await w.service.revise(VUELO, dtoV2(), USER)) as {
      avisos: string[];
    };
    await drenar();
    expect(w.vuelo.aeronave_id).toBe(N4142R);
    expect(w.escalaConAvion()).toEqual([]);
    expect(w.notifyUser).not.toHaveBeenCalled();
    // DTO = el cotizado vigente (XA-VGV): no hay cambio que avisar.
    expect(res.avisos.join(' ')).not.toMatch(/solo cambia con qué se cobra/);
  });

  it('GET /quotes/:id sobre ese estado: utilizada = N4142R (tramos), cotizada = Cessna 206, difiere por ID', async () => {
    const snapV2 = {
      ...snapshotV1(),
      aeronave: { id: XAVGV, modelo: 'Cessna 206', matricula: 'XA-VGV' },
    };
    const w = mundo({ cabecera: XAVGV, calculo_snapshot: snapV2 });
    const q = (await w.service.findById(VUELO)) as Record<string, unknown>;
    expect(q.aeronave_utilizada).toMatchObject({
      id: N4142R,
      matricula: 'N4142R',
      modelo: 'PIPER SENECA V',
    });
    expect(q.aeronave_cotizada).toMatchObject({
      id: XAVGV,
      modelo: 'Cessna 206',
    });
    expect(q.aeronave_cotizada_vs_utilizada_difiere).toBe(true);
  });

  it('estado de prod DESPUÉS de la corrección (cabecera N4142R, snapshot v2): utilizada N4142R, difiere', async () => {
    const snapV2 = {
      ...snapshotV1(),
      aeronave: { id: XAVGV, modelo: 'Cessna 206', matricula: 'XA-VGV' },
    };
    const w = mundo({ calculo_snapshot: snapV2 });
    const q = (await w.service.findById(VUELO)) as Record<string, unknown>;
    expect(q.aeronave_utilizada).toMatchObject({ id: N4142R });
    expect(q.aeronave_cotizada_vs_utilizada_difiere).toBe(true);
  });
});

describe('#338 — no regresión y decisiones congeladas', () => {
  it('CONTROL (invariante 14 R2 intacto): el MISMO cambio en el vuelo CONFIRMADO sin tacos SÍ reasigna, valida y avisa', async () => {
    const w = mundo({ estado: 'CONFIRMADO', tacos: false });
    const res = (await w.service.revise(VUELO, dtoV2(), USER)) as {
      avisos: string[];
    };
    await drenar();
    expect(w.vuelo.aeronave_id).toBe(XAVGV);
    expect(w.validateAssignTargets).toHaveBeenCalledWith(
      { aeronaveId: XAVGV },
      { aceptarDiscrepanciaAlta: false },
    );
    // Blanket SELECTIVO a los tramos vivos (herencia o avión viejo, sin taco).
    expect(w.escalaConAvion()).toHaveLength(1);
    expect(w.escalaConAvion()[0].patch.aeronave_id).toBe(XAVGV);
    expect(w.patchVuelo()!.fecha_traslado_final).toBe(
      '2026-09-24T15:00:00.000Z',
    );
    const t = titulos(w);
    // Piloto Y copiloto: «cambio de avión» y «reagendado» (el regreso).
    expect(t.filter((x) => /cambio de avión/.test(x))).toHaveLength(2);
    expect(t.filter((x) => /reagendado/.test(x))).toHaveLength(2);
    expect(res.avisos.join(' ')).not.toMatch(/ya voló/);
  });

  it('EN_VUELO con el tramo 1 volado y el 2 pendiente: el avión es SOLO COMERCIAL; el REGRESO sí se reagenda y avisa', async () => {
    const w = mundo({ estado: 'EN_VUELO', soloTramo1: true });
    const res = (await w.service.revise(
      VUELO,
      dtoV2({
        // La oficina mueve la salida (ya voló: se conserva) y el regreso.
        fecha_vuelo: new Date('2026-09-24T14:00:00.000Z'),
        fecha_traslado_final: new Date('2026-09-24T16:00:00.000Z'),
      }),
      USER,
    )) as { avisos: string[] };
    await drenar();
    expect(w.vuelo.aeronave_id).toBe(N4142R);
    expect(w.escalaConAvion()).toEqual([]);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
    const p = w.patchVuelo()!;
    expect('fecha_vuelo' in p).toBe(false);
    expect(p.fecha_traslado_final).toBe('2026-09-24T16:00:00.000Z');
    const t = titulos(w);
    expect(t.some((x) => /cambio de avión/.test(x))).toBe(false);
    expect(t.filter((x) => /reagendado/.test(x))).toHaveLength(2);
    const cuerpos = (w.notifyUser.mock.calls as unknown[][]).map(
      (c) => (c[1] as { cuerpo?: string }).cuerpo ?? '',
    );
    expect(cuerpos.every((c) => /el REGRESO ahora sale/.test(c))).toBe(true);
    expect(cuerpos.some((c) => /ahora sale 24\/09\/26, 9:00/.test(c))).toBe(
      false,
    );
    expect(res.avisos).toContain(AVISO_338);
    expect(res.avisos.join(' ')).toMatch(
      /El vuelo ya voló: la fecha de salida no se cambia/,
    );
  });

  it('reviseParaGrupo (conservarAvionOperativo) sobre el vuelo volado: ni reasigna, ni avisa, ni dice «solo comercial»', async () => {
    const w = mundo();
    const grupo: GrupoHijoOpts = {
      id: 'g-1',
      folio: 1,
      posicion: 1,
      pax: 1,
      total_aviones: 1,
    };
    const res = (await w.service.reviseParaGrupo(
      VUELO,
      dtoV2(),
      USER,
      grupo,
    )) as { avisos: string[] };
    await drenar();
    expect(w.vuelo.aeronave_id).toBe(N4142R);
    expect(w.escalaConAvion()).toEqual([]);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
    expect(w.notifyUser).not.toHaveBeenCalled();
    expect(res.avisos.join(' ')).not.toMatch(/solo cambia con qué se cobra/);
  });

  it('vista previa (preview-html) predice lo mismo que revise: el quote-like conserva N4142R', async () => {
    const w = mundo();
    const { fecha_vuelo: salida, motivo: _motivo, ...resto } = dtoV2();
    void _motivo;
    const preview: PreviewQuoteDto = {
      ...resto,
      quote_id: VUELO,
      sucio: true,
      fecha_traslado_inicial: salida,
    };
    const fila = await w.service.quoteLikeParaPreview(preview);
    expect(fila.aeronave_id).toBe(N4142R);
    expect(fila.fecha_traslado_final).toBeNull();
  });
});

/**
 * FECHA POR TRAMO de un tramo que YA VOLÓ (revisión adversaria 24-sep-2026):
 * `resolverFechasDeRevision` protegía las fechas del VUELO, pero una fecha
 * EXPLÍCITA por tramo en el cotizador (`escalas[i].fecha_salida_plan`) seguía
 * reescribiendo la `fecha_salida_plan` del tramo volado vía `replaceEscalas`
 * (vuelos con `itinerario_operativo = false`) — evento de Google, calendario
 * y día del tramo en la app. Variante del #338 con los dos tramos comerciales.
 */
describe('#338 — la fecha planeada de un tramo que YA VOLÓ no se mueve desde la cotización', () => {
  const T2 = '8ab25208-ab97-468a-b531-f1a89638234b';
  const dtoConFechaTramo2 = () =>
    dtoV2({
      escalas: [
        { ...RUTA[0] },
        { ...RUTA[1], fecha_salida_plan: new Date('2026-09-24T17:00:00Z') },
      ],
    });

  it('COMPLETADO: el tramo 2 (volado) conserva su fecha y la revisión lo avisa', async () => {
    const w = mundo({ itinerarioOperativo: false });
    const res = (await w.service.revise(VUELO, dtoConFechaTramo2(), USER)) as {
      avisos: string[];
    };
    const t2 = w.updates.find((u) => u.tabla === 'escala' && u.id === T2);
    expect(t2).toBeDefined();
    expect('fecha_salida_plan' in t2!.patch).toBe(false);
    expect(res.avisos.join(' ')).toMatch(
      /El tramo 2 \(PTU → CUN\) ya voló: su fecha de salida no se cambia desde la cotización \(movería el calendario\); se conserva la del vuelo: /,
    );
    // Y el avión tampoco se movió en ningún tramo.
    expect(w.escalaConAvion()).toEqual([]);
  });

  it('sin fecha nueva para el tramo (el cotizador no la tocó): ni se escribe ni se avisa', async () => {
    const w = mundo({ itinerarioOperativo: false });
    const res = (await w.service.revise(VUELO, dtoV2(), USER)) as {
      avisos: string[];
    };
    const t2 = w.updates.find((u) => u.tabla === 'escala' && u.id === T2);
    expect('fecha_salida_plan' in (t2?.patch ?? {})).toBe(false);
    expect(res.avisos.join(' ')).not.toMatch(/El tramo 2/);
  });

  it('CONTROL: el mismo tramo SIN tacómetro sí toma la fecha explícita de la oficina', async () => {
    const w = mundo({
      itinerarioOperativo: false,
      estado: 'CONFIRMADO',
      tacos: false,
    });
    await w.service.revise(VUELO, dtoConFechaTramo2(), USER);
    const t2 = w.updates.find((u) => u.tabla === 'escala' && u.id === T2);
    expect(t2!.patch.fecha_salida_plan).toBe('2026-09-24T17:00:00.000Z');
  });
});
