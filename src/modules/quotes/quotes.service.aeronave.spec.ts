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
const V1 = 'vvvvvvvv-0000-4000-8000-000000000254';
const USER = 'uuuuuuuu-0000-4000-8000-00000000000f';

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
  /** Tramos VIVOS extra (el 1 siempre existe); se usan para los tacos. */
  tramosExtra?: Row[];
  /** Discrepancias ALTA abiertas del avión NUEVO (pre-check de assign). */
  squawks?: { id: string; descripcion: string }[];
  /** El avión NUEVO está en taller (bloquea siempre). */
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
  // FlightsService (taller / squawk ALTA), jamás replica la regla. El doble
  // simula solo lo que el contrato promete: taller lanza siempre; squawk
  // ALTA lanza salvo `aceptarDiscrepanciaAlta`, y entonces DEVUELVE la lista
  // para que el caller avise al mecánico.
  const validateAssignTargets = jest.fn(
    (
      _targets: { aeronaveId?: string | null },
      opts?: { aceptarDiscrepanciaAlta?: boolean },
    ) => {
      if (m.taller) {
        return Promise.reject(
          new ConflictException({
            message:
              'No se puede asignar: la aeronave está en taller (mantenimiento en curso).',
            error: 'AERONAVE_EN_TALLER',
            details: { aeronave_id: _targets.aeronaveId, matricula: 'XB-ANU' },
          }),
        );
      }
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
      return Promise.resolve(lista);
    },
  );
  const notificarSquawkAceptado = jest.fn();
  const flights = {
    validateAssignTargets,
    notificarSquawkAceptado,
  } as unknown as FlightsService;
  const service = new QuotesService(
    aircraft,
    airports,
    {} as RoutesService,
    supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
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
 * `assign` (taller / squawk ALTA) ANTES de escribir, y el blanket a tramos
 * respeta lo que YA VOLÓ (invariante 1: los tacos, las horas de motor, los
 * gastos y el balance cuelgan de la matrícula con la que se voló).
 */
describe('QuotesService.revise — candados al cambiar de avión (taller / squawk)', () => {
  it('valida el avión NUEVO con el pre-check de assign (fuente única) antes de escribir', async () => {
    const w = armar();
    await w.service.revise(V1, dto(C206), USER);
    expect(w.validateAssignTargets).toHaveBeenCalledWith(
      { aeronaveId: C206 },
      { aceptarDiscrepanciaAlta: false },
    );
  });

  it('avión NUEVO en taller → 409 AERONAVE_EN_TALLER y NADA se escribe', async () => {
    const w = armar({ taller: true });
    await expect(w.service.revise(V1, dto(C206), USER)).rejects.toMatchObject({
      response: { error: 'AERONAVE_EN_TALLER' },
    });
    expect(w.patchVuelo()).toBeNull();
    expect(w.blanketEscala()).toBeNull();
    expect(w.inserts).toHaveLength(0);
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

  it('una revisión que NO cambia de avión no pide pre-check (ni taller ni squawk)', async () => {
    const w = armar();
    await w.service.revise(V1, dto(SENECA), USER);
    expect(w.validateAssignTargets).not.toHaveBeenCalled();
  });
});

describe('QuotesService.revise — el blanket respeta lo que YA VOLÓ', () => {
  it('el blanket excluye en BD los tramos con tacómetro y los anota en avisos[]', async () => {
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
    const blanket = w.blanketEscala()!;
    // La exclusión viaja en el UPDATE: un tramo volado no se mueve ni por
    // una carrera con otra escritura.
    expect(blanket.ops).toContainEqual({
      m: 'is',
      args: ['taco_salida', null],
    });
    expect(blanket.ops).toContainEqual({
      m: 'is',
      args: ['taco_llegada', null],
    });
    expect(res.avisos.join(' ')).toMatch(/tacómetro capturado NO se movieron/);
    expect(res.avisos.join(' ')).toContain('#2');
  });

  it('sin tramos volados no hay aviso (el itinerario entero siguió al avión nuevo)', async () => {
    const w = armar();
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    expect(res.avisos).toEqual([]);
    expect(w.blanketEscala()).not.toBeNull();
  });

  it('vuelo COMPLETADO: se guarda el avión nuevo pero NINGÚN tramo se mueve (avisado)', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'COMPLETADO' }) });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    // El vuelo y el snapshot sí conservan el cambio (contrato de #254).
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    expect(w.blanketEscala()).toBeNull();
    expect(res.avisos.join(' ')).toMatch(/COMPLETADO/);
    expect(res.avisos.join(' ')).toMatch(/NO se movieron de aeronave/);
  });

  it('vuelo EN_VUELO: mismo freno (el cambio operativo se hace con "Cambiar aeronave")', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'EN_VUELO' }) });
    const res = (await w.service.revise(V1, dto(C206), USER)) as {
      avisos: string[];
    };
    expect(w.patchVuelo()!.aeronave_id).toBe(C206);
    expect(w.blanketEscala()).toBeNull();
    expect(res.avisos.join(' ')).toMatch(/EN VUELO/);
  });
});

describe('QuotesService.calculate — el avión del DTO manda en el snapshot', () => {
  it('el breakdown trae la ficha del avión pedido (fuente del «Aeronave cotizada»)', async () => {
    const w = armar();
    const b = await w.service.calculate(dto(C206));
    expect(b.aeronave).toMatchObject({ id: C206, modelo: 'Cessna 206' });
  });
});
