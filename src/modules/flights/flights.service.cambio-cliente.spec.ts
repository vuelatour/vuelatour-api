// Mismos stubs que flights.service.confirmar.spec.ts: notifications arrastra
// el gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots calendar/users (push, firebase).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));
// Sondas de migraciones: se fijan aquí (la conducta con y sin ellas se
// prueba por caso).
jest.mock('../../common/factura-emitida-disponible.util', () => ({
  ...jest.requireActual<object>('../../common/factura-emitida-disponible.util'),
  facturaEmitidaDisponible: jest.fn(),
}));
jest.mock('../../common/ingreso-disponible.util', () => ({
  ...jest.requireActual<object>('../../common/ingreso-disponible.util'),
  ingresosDisponibles: jest.fn(),
}));

import { ConflictException, HttpException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import { facturaEmitidaDisponible } from '../../common/factura-emitida-disponible.util';
import { ingresosDisponibles } from '../../common/ingreso-disponible.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';

/**
 * CAMBIAR EL CLIENTE de un vuelo / cotización que ya existe (27-nov-2026,
 * `PATCH /v1/flights/:id/cliente`): candados con code estable, idempotencia,
 * CAS, sello en notas internas y avisos — el PRECIO no se toca. Supabase se
 * simula con un builder encadenable: se prueba el CONTRATO, no la BD.
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
};

const METODOS = [
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
  'insert',
  'update',
  'delete',
];

function fakeSupabase(resolver: (tabla: string, ops: Op[]) => Resultado) {
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
        };
      };
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
  };
  return { service } as unknown as SupabaseService;
}

const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];
const tieneOp = (ops: Op[], m: string, col: string): boolean =>
  ops.some((o) => o.m === m && o.args[0] === col);

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const C_VIEJO = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const C_NUEVO = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const GRUPO = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const UPDATED = '2026-11-27T15:00:00.123456+00:00';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 501,
    cliente_id: C_VIEJO,
    aeronave_id: AVION,
    estado: 'CONFIRMADO',
    es_externo: false,
    cobrado: false,
    facturado: false,
    origen_iata: 'CUN',
    destino_iata: 'PTU',
    monto_total_usd: 1624,
    grupo_id: null,
    grupo: null,
    notas_internas: 'Nota de la oficina',
    updated_at: UPDATED,
    ...extra,
  };
}

const clienteRow = (id: string, nombre: string, extra: Row = {}): Row => ({
  id,
  nombre,
  activo: true,
  es_interno: false,
  es_broker: false,
  ...extra,
});

interface Mundo {
  vuelo?: Row | null;
  clientes?: Record<string, Row>;
  /** Tarifa preferencial del cliente NUEVO en el avión cotizado. */
  preferencialNuevo?: number | null;
  snapshot?: Row | null;
  ligasFactura?: Row[];
  facturaEstatus?: string;
  sinColumnaEstatus?: boolean;
  cobros?: Row[];
  solicitud?: boolean;
  /** El UPDATE no toca filas; la relectura devuelve esta fila. */
  casPierde?: Row;
  updateError?: { code?: string; message: string };
  avisosFallan?: boolean;
  mesCerrado?: boolean;
  facturasDisponibles?: boolean;
}

function armar(m: Mundo = {}) {
  const updates: { patch: Row; ops: Op[] }[] = [];
  const lecturas: { tabla: string; sel: string }[] = [];
  let lecturasVuelo = 0;
  const fila = (): Row | null => (m.vuelo === undefined ? vueloRow() : m.vuelo);
  const clientes = m.clientes ?? {
    [C_VIEJO]: clienteRow(C_VIEJO, 'Beh Kay'),
    [C_NUEVO]: clienteRow(C_NUEVO, 'January Davila'),
  };
  (facturaEmitidaDisponible as jest.Mock).mockResolvedValue(
    m.facturasDisponibles ?? true,
  );
  (ingresosDisponibles as jest.Mock).mockResolvedValue(true);

  const supabase = fakeSupabase((tabla, ops) => {
    const upd = ops.find((o) => o.m === 'update');
    const selArg = ops.find((o) => o.m === 'select')?.args[0];
    const sel = typeof selArg === 'string' ? selArg : '';
    if (!upd) lecturas.push({ tabla, sel });
    switch (tabla) {
      case 'vuelo': {
        if (upd) {
          updates.push({ patch: upd.args[0] as Row, ops });
          if (m.updateError) return { error: m.updateError };
          if (m.casPierde) return { data: null };
          return { data: { ...(fila() ?? {}), ...(upd.args[0] as Row) } };
        }
        if (sel === 'factura_estatus') {
          return m.sinColumnaEstatus
            ? {
                error: {
                  code: '42703',
                  message: 'column vuelo.factura_estatus does not exist',
                },
              }
            : { data: { factura_estatus: m.facturaEstatus ?? 'SIN_FACTURA' } };
        }
        if (sel.startsWith('calculo_snapshot')) {
          if (m.avisosFallan) return { error: { message: 'boom' } };
          return {
            data: {
              calculo_snapshot: m.snapshot === undefined ? null : m.snapshot,
              tarifa_hora_usd: 650,
              tarifa_tipo: 'PUBLICO',
            },
          };
        }
        if (sel === 'factura_solicitada_at') {
          return {
            data: {
              factura_solicitada_at: m.solicitud
                ? '2026-11-20T15:00:00+00:00'
                : null,
            },
          };
        }
        lecturasVuelo += 1;
        if (lecturasVuelo > 1 && m.casPierde) return { data: m.casPierde };
        return { data: fila() };
      }
      case 'cliente': {
        const id = String(eqDe(ops, 'id'));
        if (sel.startsWith('es_interno')) {
          return {
            data: {
              es_interno: clientes[id]?.es_interno === true,
              tarifas:
                m.preferencialNuevo != null
                  ? [{ tarifa_hora_usd: m.preferencialNuevo }]
                  : [],
            },
          };
        }
        return { data: clientes[id] ?? null };
      }
      case 'usuario':
        return { data: { nombre: 'Itzi' } };
      case 'factura_emitida_vuelo':
        return { data: m.ligasFactura ?? [] };
      case 'cobro_vuelo':
        return { data: m.cobros ?? [] };
      default:
        return { data: null };
    }
  });

  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const notifyRole = jest.fn().mockResolvedValue(undefined);
  const notifyUser = jest.fn().mockResolvedValue(undefined);
  const svc = new FlightsService(
    supabase,
    { syncFlight } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    { notifyRole, notifyUser } as unknown as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  const mesAbierto = jest
    .spyOn(
      svc as unknown as { assertVueloEnMesAbierto: () => Promise<void> },
      'assertVueloEnMesAbierto',
    )
    .mockImplementation(() =>
      m.mesCerrado
        ? Promise.reject(
            new ConflictException({
              message: 'Octubre 2026 ya está cerrado.',
              error: 'MES_CERRADO',
            }),
          )
        : Promise.resolve(),
    );
  return {
    svc,
    updates,
    lecturas,
    syncFlight,
    notifyRole,
    notifyUser,
    mesAbierto,
  };
}

const codigoDe = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const r = (e as HttpException).getResponse() as {
      error?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    return {
      status: (e as HttpException).getStatus(),
      code: r.error,
      message: r.message,
      details: r.details,
    };
  }
  throw new Error('se esperaba un rechazo');
};

const SNAP_LISTA = {
  aeronave: { id: AVION },
  tarifa: {
    tipo: 'PUBLICO',
    usd_por_hora: 650,
    proviene_de_override: false,
    preferencial_cliente: false,
  },
};

describe('FlightsService.cambiarCliente — camino feliz', () => {
  it('escribe SOLO el cliente y el sello; responde vuelo + avisos + clientes', async () => {
    const { svc, updates, syncFlight, notifyRole, notifyUser } = armar({
      snapshot: SNAP_LISTA,
    });
    const r = (await svc.cambiarCliente(
      V1,
      { cliente_id: C_NUEVO },
      USER,
    )) as Row;

    expect(updates).toHaveLength(1);
    const { patch, ops } = updates[0];
    // Ni precio, ni snapshot, ni tarifa: solo el cliente, el sello y quién.
    expect(Object.keys(patch).sort()).toEqual([
      'cliente_id',
      'notas_internas',
      'updated_by',
    ]);
    expect(patch.cliente_id).toBe(C_NUEVO);
    expect(patch.updated_by).toBe(USER);
    const notas = String(patch.notas_internas).split('\n');
    expect(notas[0]).toBe('Nota de la oficina');
    expect(notas[1]).toMatch(
      /^\[Cliente cambiado el \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} por Itzi: «Beh Kay» → «January Davila»\]$/,
    );
    // CAS: el cliente que se leyó y `facturado = false`.
    expect(eqDe(ops, 'id')).toBe(V1);
    expect(eqDe(ops, 'cliente_id')).toBe(C_VIEJO);
    expect(eqDe(ops, 'facturado')).toBe(false);
    // Sin `if_updated_at` no hay ventana de versión.
    expect(tieneOp(ops, 'gte', 'updated_at')).toBe(false);

    expect(r.cliente_id).toBe(C_NUEVO);
    expect(r.sin_cambio).toBe(false);
    expect(r.avisos).toEqual([]);
    expect(r.cliente_anterior).toEqual({ id: C_VIEJO, nombre: 'Beh Kay' });
    expect(r.cliente).toEqual({ id: C_NUEVO, nombre: 'January Davila' });
    // Google se sincroniza; la tripulación NO recibe aviso (no cambia la operación).
    expect(syncFlight).toHaveBeenCalledWith(V1);
    expect(notifyRole).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('con `if_updated_at` vigente el UPDATE lleva la ventana de versión', async () => {
    const { svc, updates } = armar();
    await svc.cambiarCliente(
      V1,
      { cliente_id: C_NUEVO, if_updated_at: '2026-11-27T15:00:00.123Z' },
      USER,
    );
    expect(tieneOp(updates[0].ops, 'gte', 'updated_at')).toBe(true);
    expect(tieneOp(updates[0].ops, 'lte', 'updated_at')).toBe(true);
  });

  it('vuelo CANCELADO y COMPLETADO también cambian de cliente', async () => {
    for (const estado of ['CANCELADO', 'COMPLETADO', 'COTIZADO', 'EN_VUELO']) {
      const { svc, updates } = armar({ vuelo: vueloRow({ estado }) });
      await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER);
      expect(updates).toHaveLength(1);
    }
  });

  it('vuelo sin notas internas: el sello queda solo', async () => {
    const { svc, updates } = armar({
      vuelo: vueloRow({ notas_internas: null }),
    });
    await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER);
    expect(String(updates[0].patch.notas_internas)).toMatch(
      /^\[Cliente cambiado el /,
    );
  });
});

describe('FlightsService.cambiarCliente — idempotencia', () => {
  it('mismo cliente ⇒ 200 sin_cambio, sin escribir, sin candados y sin mirar la versión', async () => {
    const { svc, updates, mesAbierto, syncFlight } = armar({
      // Aunque esté facturado, sea de grupo y el mes esté cerrado: no cambia nada.
      vuelo: vueloRow({ facturado: true, grupo_id: GRUPO }),
      mesCerrado: true,
    });
    const r = (await svc.cambiarCliente(
      V1,
      { cliente_id: C_VIEJO, if_updated_at: '2020-01-01T00:00:00Z' },
      USER,
    )) as Row;
    expect(r.sin_cambio).toBe(true);
    expect(r.avisos).toEqual([]);
    expect(r.cliente).toEqual({ id: C_VIEJO, nombre: 'Beh Kay' });
    expect(updates).toHaveLength(0);
    expect(mesAbierto).not.toHaveBeenCalled();
    expect(syncFlight).not.toHaveBeenCalled();
  });
});

describe('FlightsService.cambiarCliente — candados (nada se escribe)', () => {
  it('vuelo que no existe ⇒ 404 VUELO_NO_EXISTE', async () => {
    const { svc, updates } = armar({ vuelo: null });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(404);
    expect(e.code).toBe('VUELO_NO_EXISTE');
    expect(updates).toHaveLength(0);
  });

  it('cliente que no existe ⇒ 404 CLIENTE_NO_EXISTE', async () => {
    const { svc, updates } = armar({
      clientes: { [C_VIEJO]: clienteRow(C_VIEJO, 'Beh Kay') },
    });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(404);
    expect(e.code).toBe('CLIENTE_NO_EXISTE');
    expect(updates).toHaveLength(0);
  });

  it('versión vieja ⇒ 409 CONFLICTO_VERSION con la fila viva', async () => {
    const { svc, updates } = armar();
    const e = await codigoDe(
      svc.cambiarCliente(
        V1,
        { cliente_id: C_NUEVO, if_updated_at: '2026-11-27T14:00:00.000Z' },
        USER,
      ),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('CONFLICTO_VERSION');
    expect((e.details?.actual as Row).id).toBe(V1);
    expect(updates).toHaveLength(0);
  });

  it('cliente dado de baja ⇒ 400 CLIENTE_INACTIVO', async () => {
    const { svc, updates } = armar({
      clientes: {
        [C_VIEJO]: clienteRow(C_VIEJO, 'Beh Kay'),
        [C_NUEVO]: clienteRow(C_NUEVO, 'January Davila', { activo: false }),
      },
    });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(400);
    expect(e.code).toBe('CLIENTE_INACTIVO');
    expect(updates).toHaveLength(0);
  });

  it('hijo de GRUPO ⇒ 409 VUELO_DE_GRUPO con el folio del grupo', async () => {
    const { svc, updates } = armar({
      vuelo: vueloRow({ grupo_id: GRUPO, grupo: { id: GRUPO, folio: 12 } }),
    });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('VUELO_DE_GRUPO');
    expect(e.message).toContain('G-12');
    expect(updates).toHaveLength(0);
  });

  it('CFDI timbrado (`facturado`) ⇒ 409 VUELO_FACTURADO', async () => {
    const { svc, updates } = armar({ vuelo: vueloRow({ facturado: true }) });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('VUELO_FACTURADO');
    expect(e.details).toEqual({ motivo: 'CFDI' });
    expect(updates).toHaveLength(0);
  });

  it('factura emitida VIGENTE ligada ⇒ 409 VUELO_FACTURADO con la factura; una cancelada o borrada no frena', async () => {
    const liga = (extra: Row) => ({
      factura_id: 'f-1',
      factura: {
        serie: 'A',
        folio: '0440',
        estatus: 'VIGENTE',
        deleted_at: null,
        ...extra,
      },
    });
    const frena = armar({ ligasFactura: [liga({})] });
    const e = await codigoDe(
      frena.svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.code).toBe('VUELO_FACTURADO');
    expect(e.details?.motivo).toBe('FACTURA_EMITIDA');
    expect(e.details?.facturas).toHaveLength(1);
    expect(frena.updates).toHaveLength(0);

    const pasa = armar({
      ligasFactura: [
        liga({ estatus: 'CANCELADA' }),
        liga({ deleted_at: '2026-11-01T00:00:00Z' }),
      ],
    });
    await pasa.svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER);
    expect(pasa.updates).toHaveLength(1);
  });

  it('sin la migración de facturas emitidas no se lee el puente', async () => {
    const { svc, updates, lecturas } = armar({ facturasDisponibles: false });
    await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER);
    expect(lecturas.some((l) => l.tabla === 'factura_emitida_vuelo')).toBe(
      false,
    );
    expect(updates).toHaveLength(1);
  });

  it.each(['FACTURADO', 'ELABORADA_ENVIADA'])(
    'estatus manual de factura %s ⇒ 409 VUELO_FACTURADO (ESTATUS_MANUAL)',
    async (facturaEstatus) => {
      const { svc, updates } = armar({ facturaEstatus });
      const e = await codigoDe(
        svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
      );
      expect(e.status).toBe(409);
      expect(e.code).toBe('VUELO_FACTURADO');
      expect(e.details).toEqual({ motivo: 'ESTATUS_MANUAL' });
      expect(updates).toHaveLength(0);
    },
  );

  it('base sin la columna `factura_estatus` ⇒ no frena (no hay estatus que leer)', async () => {
    const { svc, updates } = armar({ sinColumnaEstatus: true });
    await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER);
    expect(updates).toHaveLength(1);
  });

  it('mes contable CERRADO ⇒ 409 MES_CERRADO', async () => {
    const { svc, updates, mesAbierto } = armar({ mesCerrado: true });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('MES_CERRADO');
    expect(mesAbierto).toHaveBeenCalledWith(V1);
    expect(updates).toHaveLength(0);
  });
});

describe('FlightsService.cambiarCliente — carreras', () => {
  it('alguien lo modificó entre la lectura y el write ⇒ 409 CONFLICTO_VERSION', async () => {
    const { svc, syncFlight } = armar({
      casPierde: vueloRow({ updated_at: '2026-11-27T16:00:00+00:00' }),
    });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe('CONFLICTO_VERSION');
    expect(syncFlight).not.toHaveBeenCalled();
  });

  it('se timbró el CFDI entre la lectura y el write ⇒ 409 VUELO_FACTURADO', async () => {
    const { svc } = armar({ casPierde: vueloRow({ facturado: true }) });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.code).toBe('VUELO_FACTURADO');
  });

  it('el cliente se borró entre la lectura y el write (23503) ⇒ 404 CLIENTE_NO_EXISTE', async () => {
    const { svc } = armar({
      updateError: { code: '23503', message: 'fk vuelo_cliente_id_fkey' },
    });
    const e = await codigoDe(
      svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER),
    );
    expect(e.status).toBe(404);
    expect(e.code).toBe('CLIENTE_NO_EXISTE');
  });
});

describe('FlightsService.cambiarCliente — avisos (el precio no cambia)', () => {
  it('tarifa preferencial del cliente nuevo en el avión COTIZADO', async () => {
    const { svc, lecturas } = armar({
      snapshot: SNAP_LISTA,
      preferencialNuevo: 600,
    });
    const r = (await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER)) as {
      avisos: string[];
    };
    expect(r.avisos).toEqual([
      'January Davila tiene tarifa preferencial de $600/hr en este avión y la cotización conserva $650/hr: el precio NO cambió. La próxima versión que se guarde de la cotización se cotizará con $600/hr.',
    ]);
    // La regla es la del motor: la MISMA consulta de `leerContextoCliente`.
    expect(
      lecturas.some(
        (l) =>
          l.tabla === 'cliente' &&
          l.sel ===
            'es_interno, tarifas:tarifa_cliente_aeronave(tarifa_hora_usd)',
      ),
    ).toBe(true);
  });

  it('cliente nuevo INTERNO, cobros (uno de anticipo) y «Necesito factura»', async () => {
    const { svc } = armar({
      snapshot: SNAP_LISTA,
      clientes: {
        [C_VIEJO]: clienteRow(C_VIEJO, 'Beh Kay'),
        [C_NUEVO]: clienteRow(C_NUEVO, 'Servicio', { es_interno: true }),
      },
      cobros: [
        { id: 'k-1', ingreso_anticipo_id: null },
        { id: 'k-2', ingreso_anticipo_id: 'i-1' },
      ],
      solicitud: true,
    });
    const r = (await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER)) as {
      avisos: string[];
    };
    expect(r.avisos).toHaveLength(4);
    expect(r.avisos[0]).toContain('Servicio es un cliente INTERNO');
    expect(r.avisos[0]).toContain('conserva su total de $1,624 USD');
    expect(r.avisos[1]).toContain('2 cobros registrados');
    expect(r.avisos[2]).toContain('1 de esos cobros viene de un anticipo');
    expect(r.avisos[3]).toContain('«Necesito factura»');
  });

  it('si los avisos no se pueden armar, el cambio YA guardado responde 200 con avisos vacíos', async () => {
    const { svc, updates } = armar({ avisosFallan: true });
    const r = (await svc.cambiarCliente(V1, { cliente_id: C_NUEVO }, USER)) as {
      avisos: string[];
      cliente_id: string;
    };
    expect(updates).toHaveLength(1);
    expect(r.cliente_id).toBe(C_NUEVO);
    expect(r.avisos).toEqual([]);
  });
});
