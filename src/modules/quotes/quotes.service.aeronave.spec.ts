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

import { ConflictException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { avisoAeronaveEnTaller } from '../../common/aviso-taller.util';
import { MetodoPago, TipoTarifa, TipoVuelo } from './dto/calculate-quote.dto';
import type { ReviseQuoteDto } from './dto/revise-quote.dto';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { FlightsService } from '../flights/flights.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';

/**
 * BUG COTIZACIÓN #254 (11-sep-2026): cambiar el avión en el cotizador no se
 * persistía. La versión nueva guardaba el avión nuevo en el snapshot y en el
 * historial, pero `vuelo.aeronave_id` se quedaba con el original (el avión
 * del tramo 1 mandaba SIEMPRE), así que el formulario volvía a abrir con el
 * viejo, cada versión repetía el mismo diff «Avión PIPER SENECA V→…» y la
 * hoja seguía diciendo «Aeronave cotizada: PIPER SENECA V».
 *
 * Aquí se prueba el CONTRATO de `revise` con un Supabase simulado: qué se
 * escribe en `vuelo` y en `escala`. El caso #80 (la revisión que NO cambia
 * de avión no pisa la asignación operativa) queda fijado en el mismo spec.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const SENECA = 'aaaaaaaa-0000-4000-8000-0000000seneca';
const C206 = 'aaaaaaaa-0000-4000-8000-00000000c206';
const N990 = 'aaaaaaaa-0000-4000-8000-00000000n990';
const V1 = 'vvvvvvvv-0000-4000-8000-000000000254';
const USER = 'uuuuuuuu-0000-4000-8000-00000000000f';
const PILOTO = 'pppppppp-0000-4000-8000-00000000000p';

const FICHAS: Record<string, Row> = {
  [SENECA]: {
    id: SENECA,
    activa: true,
    matricula: 'XA-VGV',
    modelo: 'PIPER SENECA V',
    pais_registro: 'MX',
    velocidad_crucero_kts: 170,
    tarifa_hora_pub_usd: 1000,
    tarifa_hora_broker_usd: 900,
  },
  [C206]: {
    id: C206,
    activa: true,
    matricula: 'XB-ANU',
    modelo: 'Cessna 206',
    pais_registro: 'MX',
    velocidad_crucero_kts: 140,
    tarifa_hora_pub_usd: 800,
    tarifa_hora_broker_usd: 700,
  },
  // Avión OPERATIVO del caso #298 (se cotizó en otro y se vuela en este).
  [N990]: {
    id: N990,
    activa: true,
    matricula: 'N990GG',
    modelo: 'PIPER SENECA V',
    pais_registro: 'US',
    velocidad_crucero_kts: 170,
    tarifa_hora_pub_usd: 1400,
    tarifa_hora_broker_usd: 1300,
  },
};

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 254,
    cliente_id: null,
    aeronave_id: SENECA,
    estado: 'COTIZADO',
    es_externo: false,
    cotizacion_version: 1,
    facturado: false,
    cobrado: false,
    itinerario_operativo: false,
    monto_total_usd: 1000,
    tc_usd_mxn: null,
    fecha_vuelo: new Date().toISOString(),
    fecha_traslado_final: null,
    extras: [],
    calculo_snapshot: {
      aeronave: { id: SENECA, matricula: 'XA-VGV', modelo: 'PIPER SENECA V' },
    },
    notas: null,
    ...extra,
  };
}

interface Mundo {
  vuelo?: Row;
  /** Avión explícito del tramo 1 vivo (null = hereda el del vuelo). */
  aeronaveTramo1?: string | null;
  /** Columnas extra del tramo 1 (ruta, tacos, avión…); ganan sobre las de arriba. */
  tramo1?: Row;
  /** Tramos VIVOS extra (el 1 siempre existe); se usan para los tacos. */
  tramosExtra?: Row[];
  /** Discrepancias ALTA abiertas del avión NUEVO (pre-check de assign). */
  squawks?: { id: string; descripcion: string }[];
  /** El avión NUEVO está en taller (desde el 11-sep-2026 solo AVISA). */
  taller?: boolean;
}

function escalaRow(extra: Row = {}): Row {
  return {
    id: 'e-1',
    vuelo_id: V1,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    aeronave_id: SENECA,
    millas_nauticas: 80,
    pasajeros: 3,
    es_ferry: false,
    solo_operativa: false,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    tipo_parada: 'NORMAL',
    requiere_pernocta: false,
    fecha_salida_plan: null,
    ...extra,
  };
}

function armar(m: Mundo = {}) {
  const updates: { tabla: string; patch: Row; ops: Op[] }[] = [];
  const inserts: { tabla: string; fila: Row }[] = [];
  const vuelo = m.vuelo ?? vueloRow();
  const escalas: Row[] = [
    escalaRow({
      aeronave_id: m.aeronaveTramo1 === undefined ? SENECA : m.aeronaveTramo1,
      ...(m.tramo1 ?? {}),
    }),
    ...(m.tramosExtra ?? []),
  ];
  const escalaViva = escalas[0];
  const supabase = {
    service: {
      from(tabla: string) {
        const ops: Op[] = [];
        const q: Record<string, unknown> = {};
        const selectDe = () => {
          const sel = ops.find((o) => o.m === 'select')?.args[0];
          return typeof sel === 'string' ? sel : '';
        };
        const resolve = (lista: boolean): Row => {
          const upd = ops.find((o) => o.m === 'update');
          const ins = ops.find((o) => o.m === 'insert');
          if (upd) updates.push({ tabla, patch: upd.args[0] as Row, ops });
          if (ins) inserts.push({ tabla, fila: ins.args[0] as Row });
          if (tabla === 'vuelo') {
            if (upd) return { data: { ...vuelo, ...(upd.args[0] as Row) } };
            return lista ? { data: [vuelo] } : { data: vuelo };
          }
          if (tabla === 'escala') {
            if (upd || ins) return { data: escalaViva };
            const sel = selectDe();
            if (sel === 'aeronave_id') return { data: escalaViva };
            if (sel.includes('tipo_parada, pasajeros')) {
              return { data: escalas };
            }
            if (sel === 'orden, destino_iata') return { data: [] };
            return lista ? { data: escalas } : { data: escalaViva };
          }
          if (tabla === 'aeronave') {
            const ids = (ops.find((o) => o.m === 'in')?.args[1] ??
              []) as string[];
            return { data: ids.map((id) => FICHAS[id]).filter(Boolean) };
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
    computeTuasUsdPax: jest
      .fn()
      .mockResolvedValue({ aplica: false, usd_pax: 0, razon: 'exenta' }),
    refreshPermisosDeVuelo: jest.fn().mockResolvedValue(undefined),
  } as unknown as AirportsService;
  // FUENTE ÚNICA del pre-check de asignación: `revise` DELEGA en
  // FlightsService (squawk ALTA + aviso de taller), jamás replica la regla.
  // El doble simula solo lo que el contrato promete (11-sep-2026): el TALLER
  // YA NO LANZA — devuelve su texto en `avisos`; el squawk ALTA lanza salvo
  // `aceptarDiscrepanciaAlta`, y entonces DEVUELVE la lista en
  // `squawksAceptados` para que el caller avise al mecánico.
  const validateAssignTargets = jest.fn(
    (
      _targets: { aeronaveId?: string | null },
      opts?: { aceptarDiscrepanciaAlta?: boolean },
    ) => {
      const lista = m.squawks ?? [];
      if (lista.length > 0 && opts?.aceptarDiscrepanciaAlta !== true) {
        return Promise.reject(
          new ConflictException({
            message: 'No se puede asignar: discrepancia de severidad ALTA…',
            error: 'SQUAWK_ALTA_SIN_RESOLVER',
            details: { aeronave_id: _targets.aeronaveId, discrepancias: lista },
          }),
        );
      }
      return Promise.resolve({
        squawksAceptados: lista,
        avisos: m.taller ? [avisoAeronaveEnTaller('XB-ANU')] : [],
      });
    },
  );
  const notificarSquawkAceptado = jest.fn();
  const avisoTallerDe = jest.fn(() =>
    Promise.resolve(m.taller ? [avisoAeronaveEnTaller('XB-ANU')] : []),
  );
  const flights = {
    validateAssignTargets,
    notificarSquawkAceptado,
    avisoTallerDe,
  } as unknown as FlightsService;
  const notifyUser = jest.fn().mockResolvedValue(true);
  const service = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {
      notifyUser,
      notifyRole: jest.fn().mockResolvedValue(true),
    } as unknown as NotificationsService,
    flights,
  );
  const patchVuelo = () =>
    updates.find((u) => u.tabla === 'vuelo' && 'aeronave_id' in u.patch)
      ?.patch ?? null;
  const blanketEscala = () =>
    updates.find((u) => u.tabla === 'escala' && 'aeronave_id' in u.patch) ??
    null;
  return {
    service,
    updates,
    inserts,
    patchVuelo,
    blanketEscala,
    validateAssignTargets,
    notificarSquawkAceptado,
    notifyUser,
  };
}

function dto(aeronaveId: string): ReviseQuoteDto {
  return {
    aeronave_id: aeronaveId,
    tipo: TipoVuelo.MULTIESCALA,
    escalas: [{ origen_iata: 'CUN', destino_iata: 'HOL', millas_nauticas: 80 }],
    tipo_tarifa: TipoTarifa.PUBLICO,
    pasajeros: 3,
    metodo_pago: MetodoPago.TRANSFERENCIA,
    motivo: 'Corrección',
  };
}

describe('QuotesService.revise — cambio de aeronave desde el cotizador (#254)', () => {
  it('cambiar el avión SE PERSISTE en vuelo.aeronave_id y en el snapshot', async () => {
    const w = armar();
    await w.service.revise(V1, dto(C206), USER);
    const patch = w.patchVuelo()!;
    expect(patch.aeronave_id).toBe(C206);
    // El snapshot (y con él «Aeronave cotizada» del PDF/hoja) sigue al avión
    // nuevo: el motor recalculó con su velocidad y tarifa.
    const snap = patch.calculo_snapshot as {
      aeronave: { id: string; modelo: string };
    };
    expect(snap.aeronave.id).toBe(C206);
    expect(snap.aeronave.modelo).toBe('Cessna 206');
  });

  it('los tramos vivos siguen al avión nuevo con blanket SELECTIVO (solo herencia o avión viejo)', async () => {
    const w = armar();
    await w.service.revise(V1, dto(C206), USER);
    const blanket = w.blanketEscala()!;
    expect(blanket.patch.aeronave_id).toBe(C206);
    // Acotado al vuelo, solo tramos VIVOS y solo null|avión viejo.
    expect(blanket.ops).toContainEqual({ m: 'eq', args: ['vuelo_id', V1] });
    expect(blanket.ops).toContainEqual({
      m: 'is',
      args: ['cancelada_at', null],
    });
    expect(blanket.ops).toContainEqual({
      m: 'or',
      args: [`aeronave_id.is.null,aeronave_id.eq.${SENECA}`],
    });
  });

  it('la versión nueva queda registrada con el avión nuevo (historial)', async () => {
    const w = armar();
    await w.service.revise(V1, dto(C206), USER);
    const version = w.inserts.find(
      (i) => i.tabla === 'cotizacion_version_history',
    )!;
    expect(version.fila.aeronave_id).toBe(C206);
    expect(version.fila.version).toBe(2);
  });

  it('revisión SIN cambio de avión: no reasigna nada (ni vuelo ni tramos)', async () => {
    const w = armar();
    await w.service.revise(V1, dto(SENECA), USER);
    expect(w.patchVuelo()!.aeronave_id).toBe(SENECA);
    expect(w.blanketEscala()).toBeNull();
  });

  it('caso #80: el avión OPERATIVO del tramo 1 manda cuando el cotizador no cambió de avión', async () => {
    // Cotizado en Seneca, la operación reasignó el tramo 1 al Cessna: el
    // vuelo ya tiene el Cessna y el cotizador re-envía ESE mismo avión.
    const w = armar({
      vuelo: vueloRow({ aeronave_id: C206 }),
      aeronaveTramo1: C206,
    });
    await w.service.revise(V1, dto(C206), USER);
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    expect(w.blanketEscala()).toBeNull();
  });

  it('desde el GRUPO nunca reasigna: el armado re-envía el avión como referencia y el cambio lo hace assign', async () => {
    // Hijo COMPLETADO: `groups.revise` SALTA su `flights.assign` a propósito
    // y luego recotiza igual. Sin la guarda, el hijo se movía de avión aquí
    // (y sus tramos con tacos detrás) sin validación ni aviso.
    const w = armar();
    await w.service.reviseParaGrupo(V1, dto(C206), USER, {
      id: 'g-1',
      folio: 12,
      posicion: 1,
      pax: 3,
      total_aviones: 2,
    });
    expect(w.patchVuelo()!.aeronave_id).toBe(SENECA);
    expect(w.blanketEscala()).toBeNull();
  });

  it('caso #80 (quickAdjust): con conservarAvionOperativo el avión del snapshot NO reasigna el vuelo', async () => {
    const w = armar({
      vuelo: vueloRow({ aeronave_id: C206 }),
      aeronaveTramo1: C206,
    });
    // El ajuste rápido re-envía el avión del SNAPSHOT (Seneca) para no mover
    // el precio; el vuelo debe seguir operando en el Cessna.
    await w.service.revise(V1, dto(SENECA), USER, {
      conservarAvionOperativo: true,
    });
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    expect(w.blanketEscala()).toBeNull();
  });
});

/**
 * CANDADOS DEL CAMBIO DE AVIÓN (11-sep-2026, invariante 14 + 9). Cambiar el
 * avión desde el cotizador ES una asignación: pasa por el MISMO pre-check de
 * `assign` (squawk ALTA) ANTES de escribir, y el blanket a tramos respeta lo
 * que YA VOLÓ (invariante 1: los tacos, las horas de motor, los gastos y el
 * balance cuelgan de la matrícula con la que se voló). El TALLER dejó de ser
 * candado el mismo día: solo agrega su aviso a `avisos[]`.
 */
/**
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN (cliente, 12-sep-2026,
 * cotización #298): «al realizar un ajuste en el vuelo operativo (cambio de
 * avión) terminó afectando a la cotización; esto no debe ser así: se cotiza
 * con un avión y se vuela con otro por distintos motivos, pero la cotización
 * no debe verse afectada por cambios en el vuelo operativo».
 *
 * Caso de punta a punta: snapshot = Cessna (COTIZADO), el vuelo se reasignó a
 * N990GG (OPERATIVO) y el panel guarda una versión SIN tocar el selector (el
 * cotizador rehidrata el COTIZADO) ⇒ el precio se calcula con el Cessna, el
 * vuelo sigue en el N990GG, el snapshot conserva el Cessna y NADIE recibe un
 * aviso de cambio de avión.
 */
describe('QuotesService.revise — la cotización es independiente de la operación (#298)', () => {
  const mundo298 = () =>
    armar({
      vuelo: vueloRow({
        // Se cotizó en el Cessna (snapshot) y hoy opera el N990GG.
        aeronave_id: N990,
        piloto_id: PILOTO,
        calculo_snapshot: {
          aeronave: { id: C206, matricula: 'XB-ANU', modelo: 'Cessna 206' },
        },
      }),
      aeronaveTramo1: N990,
    });

  it('guardar una versión con el avión COTIZADO no reasigna el vuelo ni sus tramos', async () => {
    const w = mundo298();
    await w.service.revise(V1, dto(C206), USER);
    const patch = w.patchVuelo()!;
    // El vuelo conserva el avión OPERATIVO…
    expect(patch.aeronave_id).toBe(N990);
    // …y ningún tramo se mueve de aeronave.
    expect(w.blanketEscala()).toBeNull();
  });

  it('el PRECIO y el snapshot se calculan con el avión COTIZADO (no con el operativo)', async () => {
    const w = mundo298();
    await w.service.revise(V1, dto(C206), USER);
    const patch = w.patchVuelo()!;
    const snap = patch.calculo_snapshot as {
      aeronave: { id: string; modelo: string };
      tarifa: { usd_por_hora: number };
    };
    expect(snap.aeronave.id).toBe(C206);
    expect(snap.aeronave.modelo).toBe('Cessna 206');
    // Tarifa del COTIZADO (800), jamás la del operativo (1400).
    expect(snap.tarifa.usd_por_hora).toBe(800);
  });

  it('no es una asignación: ni pre-check de squawk/taller ni aviso de cambio de avión a la tripulación', async () => {
    const w = mundo298();
    await w.service.revise(V1, dto(C206), USER);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
    expect(w.notificarSquawkAceptado).not.toHaveBeenCalled();
    const titulos = (w.notifyUser.mock.calls as unknown[][]).map(
      (c) => (c[1] as { titulo?: string } | undefined)?.titulo ?? '',
    );
    expect(titulos.join(' | ')).not.toMatch(/cambio de avión/i);
  });

  it('el historial registra la versión con el avión COTIZADO (lo pactado con el cliente)', async () => {
    const w = mundo298();
    await w.service.revise(V1, dto(C206), USER);
    const version = w.inserts.find(
      (i) => i.tabla === 'cotizacion_version_history',
    )!;
    expect(version.fila.aeronave_id).toBe(C206);
  });

  it('elegir un TERCER avión en el cotizador SÍ es deliberado (contrato del 11-sep intacto)', async () => {
    const w = mundo298();
    await w.service.revise(V1, dto(SENECA), USER);
    expect(w.patchVuelo()!.aeronave_id).toBe(SENECA);
    expect(w.validateAssignTargets).toHaveBeenCalledWith(
      { aeronaveId: SENECA },
      { aceptarDiscrepanciaAlta: false },
    );
    // El blanket parte del OPERATIVO anterior (N990GG), no del cotizado.
    expect(w.blanketEscala()!.ops).toContainEqual({
      m: 'or',
      args: [`aeronave_id.is.null,aeronave_id.eq.${N990}`],
    });
  });
});

describe('QuotesService.revise — candados al cambiar de avión (taller / squawk)', () => {
  it('valida el avión NUEVO con el pre-check de assign (fuente única) antes de escribir', async () => {
    const w = armar();
    await w.service.revise(V1, dto(C206), USER);
    expect(w.validateAssignTargets).toHaveBeenCalledWith(
      { aeronaveId: C206 },
      { aceptarDiscrepanciaAlta: false },
    );
  });

  it('avión NUEVO en taller: el cambio SE GUARDA y el aviso ámbar sale en avisos[] (cliente 11-sep-2026)', async () => {
    const w = armar({ taller: true });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    // Se escribió: ya no hay 409 AERONAVE_EN_TALLER en el cotizador.
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    expect(res.avisos).toContain(avisoAeronaveEnTaller('XB-ANU'));
    expect(res.avisos.join(' ')).not.toMatch(/no se puede/i);
  });

  it('squawk ALTA sin resolver → 409 estructurado con details, sin escribir', async () => {
    const squawks = [{ id: 's-1', descripcion: 'Fuga de aceite motor 1' }];
    const w = armar({ squawks });
    await expect(w.service.revise(V1, dto(C206), USER)).rejects.toMatchObject({
      response: {
        error: 'SQUAWK_ALTA_SIN_RESOLVER',
        details: { discrepancias: squawks },
      },
    });
    expect(w.patchVuelo()).toBeNull();
    expect(w.notificarSquawkAceptado).not.toHaveBeenCalled();
  });

  it('con aceptar_discrepancia_alta el cambio procede y se avisa al MECÁNICO', async () => {
    const squawks = [{ id: 's-1', descripcion: 'Fuga de aceite motor 1' }];
    const w = armar({ squawks });
    await w.service.revise(
      V1,
      { ...dto(C206), aceptar_discrepancia_alta: true },
      USER,
    );
    expect(w.validateAssignTargets).toHaveBeenCalledWith(
      { aeronaveId: C206 },
      { aceptarDiscrepanciaAlta: true },
    );
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    // El aviso al mecánico sale con el MISMO helper de assign/reassign.
    expect(w.notificarSquawkAceptado).toHaveBeenCalledWith(
      expect.objectContaining({ id: V1 }),
      C206,
      squawks,
    );
  });

  it('una revisión que NO cambia de avión no pide pre-check (ni aviso de taller ni squawk)', async () => {
    const w = armar();
    await w.service.revise(V1, dto(SENECA), USER);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
  });
});

describe('QuotesService.revise — el blanket respeta lo que YA VOLÓ', () => {
  it('el blanket excluye en BD los tramos con tacómetro (carrera: taco capturado entre la lectura y el UPDATE)', async () => {
    // Sin tacos al LEER (cambio deliberado permitido): el filtro del UPDATE
    // es la red de seguridad si el piloto captura en medio.
    const w = armar({
      tramosExtra: [
        escalaRow({
          id: 'e-2',
          orden: 2,
          origen_iata: 'HOL',
          destino_iata: 'CUN',
          aeronave_id: null,
        }),
      ],
    });
    await w.service.revise(
      V1,
      {
        ...dto(C206),
        escalas: [
          { origen_iata: 'CUN', destino_iata: 'HOL', millas_nauticas: 80 },
          { origen_iata: 'HOL', destino_iata: 'CUN', millas_nauticas: 80 },
        ],
      },
      USER,
    );
    const blanket = w.blanketEscala()!;
    expect(blanket.ops).toContainEqual({
      m: 'is',
      args: ['taco_salida', null],
    });
    expect(blanket.ops).toContainEqual({
      m: 'is',
      args: ['taco_llegada', null],
    });
  });

  it('sin tramos volados no hay aviso (el itinerario entero siguió al avión nuevo)', async () => {
    const w = armar();
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    expect(res.avisos).toEqual([]);
    expect(w.blanketEscala()).not.toBeNull();
  });

  it('un tramo con tacómetro = el vuelo YA VOLÓ: el cambio es solo comercial (ni cabecera ni tramos se mueven)', async () => {
    const w = armar({
      tramosExtra: [
        escalaRow({
          id: 'e-2',
          orden: 2,
          taco_salida: 1200.4,
          taco_llegada: 1202.1,
        }),
      ],
    });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    expect(w.patchVuelo()!.aeronave_id).toBe(SENECA);
    expect(w.blanketEscala()).toBeNull();
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
    expect(res.avisos).toContain(
      'El vuelo ya voló en XA-VGV: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.',
    );
  });

  it('vuelo COMPLETADO: el avión nuevo queda SOLO en el snapshot; el vuelo conserva el suyo', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'COMPLETADO' }) });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    const patch = w.patchVuelo()!;
    expect(patch.aeronave_id).toBe(SENECA);
    expect(
      (patch.calculo_snapshot as { aeronave: { id: string } }).aeronave.id,
    ).toBe(C206);
    expect(w.blanketEscala()).toBeNull();
    expect(res.avisos.join(' ')).toMatch(/solo cambia con qué se cobra/);
  });

  it('vuelo EN_VUELO: mismo freno (el cambio operativo se hace con "Cambiar aeronave")', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'EN_VUELO' }) });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    expect(w.patchVuelo()!.aeronave_id).toBe(SENECA);
    expect(w.blanketEscala()).toBeNull();
    expect(res.avisos.join(' ')).toMatch(/ya voló en XA-VGV/);
  });
});

/**
 * COTIZACIÓN #338 (24-sep-2026, cliente Mike Nelson, CUN→PTU→CUN) DE PUNTA A
 * PUNTA: cotizada y volada en el Seneca N4142R (tramo 1 ferry CUN–PTU tacos
 * 4460.5→4461.7, tramo 2 PTU–CUN 4461.7→4462.9, COMPLETADO). Ya aterrizada,
 * la oficina guardó la v2 «se cobra como Cessna, pidieron Cessna» con el
 * Cessna 206 XA-VGV y el regreso —→ 10:00. Antes: cabecera XA-VGV con los
 * tramos en N4142R y dos push a la tripulación («cambio de avión · Ahora
 * vuela en XA-VGV» y «el REGRESO ahora sale 24/09/26, 10:00»).
 */
describe('QuotesService.revise — vuelo YA VOLADO, cotización #338', () => {
  const N4142R = 'aaaaaaaa-0000-4000-8000-0000000n4142';
  const XAVGV = 'aaaaaaaa-0000-4000-8000-000000000vgv';
  const COPILOTO = 'pppppppp-0000-4000-8000-00000000000c';
  const REGRESO_DTO = new Date('2026-09-24T15:00:00.000Z');
  beforeAll(() => {
    FICHAS[N4142R] = {
      id: N4142R,
      activa: true,
      matricula: 'N4142R',
      modelo: 'PIPER SENECA V',
      pais_registro: 'US',
      velocidad_crucero_kts: 170,
      tarifa_hora_pub_usd: 1000,
      tarifa_hora_broker_usd: 900,
    };
    FICHAS[XAVGV] = {
      id: XAVGV,
      activa: true,
      matricula: 'XA-VGV',
      modelo: 'Cessna 206',
      pais_registro: 'MX',
      velocidad_crucero_kts: 120,
      tarifa_hora_pub_usd: 600,
      tarifa_hora_broker_usd: 600,
    };
  });

  /** `cabecera` = vuelo.aeronave_id (N4142R antes del bug; XA-VGV después). */
  const mundo338 = (
    opts: { cabecera?: string; estado?: string; tacos?: boolean } = {},
  ) => {
    const tacos = opts.tacos !== false;
    return armar({
      vuelo: vueloRow({
        folio: 338,
        estado: opts.estado ?? 'COMPLETADO',
        aeronave_id: opts.cabecera ?? N4142R,
        piloto_id: PILOTO,
        copiloto_id: COPILOTO,
        fecha_traslado_final: null,
        calculo_snapshot: {
          aeronave: {
            id: N4142R,
            matricula: 'N4142R',
            modelo: 'PIPER SENECA V',
          },
        },
      }),
      tramo1: {
        destino_iata: 'PTU',
        aeronave_id: N4142R,
        es_ferry: true,
        pasajeros: 0,
        taco_salida: tacos ? 4460.5 : null,
        taco_llegada: tacos ? 4461.7 : null,
      },
      tramosExtra: [
        escalaRow({
          id: 'e-2',
          orden: 2,
          origen_iata: 'PTU',
          destino_iata: 'CUN',
          aeronave_id: N4142R,
          taco_salida: tacos ? 4461.7 : null,
          taco_llegada: tacos ? 4462.9 : null,
        }),
      ],
    });
  };
  const dto338 = (): ReviseQuoteDto => ({
    ...dto(XAVGV),
    escalas: [
      { origen_iata: 'CUN', destino_iata: 'PTU', millas_nauticas: 60 },
      { origen_iata: 'PTU', destino_iata: 'CUN', millas_nauticas: 60 },
    ],
    fecha_traslado_final: REGRESO_DTO,
    motivo: 'Corrección',
  });
  /** Los avisos a tripulación son `void` (best-effort): se drenan. */
  const drenar = async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
  };
  const titulos = (w: ReturnType<typeof armar>) =>
    (w.notifyUser.mock.calls as unknown[][]).map(
      (c) => (c[1] as { titulo?: string } | undefined)?.titulo ?? '',
    );

  it('el vuelo SIGUE en N4142R (cabecera) y ningún tramo se mueve', async () => {
    const w = mundo338();
    await w.service.revise(V1, dto338(), USER);
    expect(w.patchVuelo()!.aeronave_id).toBe(N4142R);
    expect(w.blanketEscala()).toBeNull();
  });

  it('el PRECIO y el snapshot sí quedan con el Cessna 206 (se cobra como Cessna)', async () => {
    const w = mundo338();
    await w.service.revise(V1, dto338(), USER);
    const snap = w.patchVuelo()!.calculo_snapshot as {
      aeronave: { id: string; modelo: string };
      tarifa: { usd_por_hora: number };
    };
    expect(snap.aeronave).toMatchObject({ id: XAVGV, modelo: 'Cessna 206' });
    expect(snap.tarifa.usd_por_hora).toBe(600);
    const version = w.inserts.find(
      (i) => i.tabla === 'cotizacion_version_history',
    )!;
    expect(version.fila.aeronave_id).toBe(XAVGV);
  });

  it('no es una asignación: ni pre-check de squawk/taller ni aviso al mecánico', async () => {
    const w = mundo338();
    await w.service.revise(V1, dto338(), USER);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
    expect(w.notificarSquawkAceptado).not.toHaveBeenCalled();
  });

  it('la tripulación NO recibe «cambio de avión» ni «el REGRESO ahora sale…» (ya aterrizó)', async () => {
    const w = mundo338();
    await w.service.revise(V1, dto338(), USER);
    await drenar();
    expect(w.notifyUser).not.toHaveBeenCalled();
  });

  it('las fechas del vuelo NO se reescriben (calendario/Google/fecha_fin/mes del dinero) y se avisa', async () => {
    const w = mundo338();
    const res = (await w.service.revise(V1, dto338(), USER)) as {
      avisos: string[];
    };
    const patch = w.patchVuelo()!;
    expect('fecha_traslado_final' in patch).toBe(false);
    expect('fecha_vuelo' in patch).toBe(false);
    expect(res.avisos).toContain(
      'El viaje ya terminó: la fecha de regreso no se cambia desde la cotización (movería el calendario); el vuelo se queda sin fecha de regreso.',
    );
  });

  it('avisos[] explica con qué voló y con qué se cobra', async () => {
    const w = mundo338();
    const res = (await w.service.revise(V1, dto338(), USER)) as {
      avisos: string[];
    };
    expect(res.avisos).toContain(
      'El vuelo ya voló en N4142R: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.',
    );
  });

  it('estado ya dañado (cabecera XA-VGV, tramos N4142R): guardar REPARA la cabecera al avión que voló, sin push de «cambio de avión»', async () => {
    const w = mundo338({ cabecera: XAVGV });
    await w.service.revise(V1, dto338(), USER);
    await drenar();
    expect(w.patchVuelo()!.aeronave_id).toBe(N4142R);
    expect(w.blanketEscala()).toBeNull();
    expect(titulos(w).join(' | ')).not.toMatch(/cambio de avión/i);
  });

  it('control: el MISMO cambio en un vuelo que NO ha volado sí reasigna y avisa (contrato del 11-sep)', async () => {
    const w = mundo338({ estado: 'CONFIRMADO', tacos: false });
    await w.service.revise(V1, dto338(), USER);
    await drenar();
    expect(w.patchVuelo()!.aeronave_id).toBe(XAVGV);
    expect(w.patchVuelo()!.fecha_traslado_final).toBe(
      REGRESO_DTO.toISOString(),
    );
    expect(w.validateAssignTargets).toHaveBeenCalled();
    const t = titulos(w).join(' | ');
    expect(t).toMatch(/cambio de avión/i);
    expect(t).toMatch(/reagendado/i);
  });

  it('GET /quotes/:id: «aeronave utilizada» sale de los TRAMOS (N4142R), no de la cabecera (XA-VGV)', async () => {
    const w = mundo338({ cabecera: XAVGV });
    // Snapshot de la v2: cotizado Cessna 206 · XA-VGV.
    const q = (await w.service.findById(V1)) as Record<string, unknown>;
    expect(q.aeronave_utilizada).toMatchObject({
      id: N4142R,
      matricula: 'N4142R',
      modelo: 'PIPER SENECA V',
    });
  });

  it('cotizado ≠ utilizado se compara por ID', async () => {
    const w = armar({
      vuelo: vueloRow({
        estado: 'COMPLETADO',
        aeronave_id: XAVGV,
        calculo_snapshot: {
          aeronave: { id: XAVGV, matricula: 'XA-VGV', modelo: 'Cessna 206' },
        },
      }),
      tramo1: { aeronave_id: N4142R, taco_salida: 1, taco_llegada: 2 },
    });
    const q = (await w.service.findById(V1)) as Record<string, unknown>;
    expect(q.aeronave_cotizada).toMatchObject({ id: XAVGV });
    expect(q.aeronave_utilizada).toMatchObject({ id: N4142R });
    expect(q.aeronave_cotizada_vs_utilizada_difiere).toBe(true);
  });

  it('mismo avión cotizado y utilizado ⇒ no difiere', async () => {
    const w = armar();
    const q = (await w.service.findById(V1)) as Record<string, unknown>;
    expect(q.aeronave_utilizada).toMatchObject({ id: SENECA });
    expect(q.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });
});

describe('QuotesService.calculate — el avión del DTO manda en el snapshot', () => {
  it('el breakdown trae la ficha del avión pedido (fuente del «Aeronave cotizada»)', async () => {
    const w = armar();
    const b = await w.service.calculate(dto(C206));
    expect(b.aeronave).toMatchObject({ id: C206, modelo: 'Cessna 206' });
  });
});
