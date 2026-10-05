// Mismos stubs que expenses.service.spec.ts: notifications arrastra el
// gateway y `jose` (ESM puro), vision el SDK de IA y pyservices el cliente.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ExpensesService } from './expenses.service';
import {
  CategoriaGasto,
  MedioPago,
  Moneda,
  TipoCombustible,
} from './dto/expenses.dto';
import type { CreateGastoDto, UpdateGastoDto } from './dto/expenses.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

/**
 * COMBUSTIBLE POR AERONAVE (5-oct-2026, API 0.0.56, invariante 43). Caso
 * real: Luis capturó desde la app 74 L para el vuelo #280 del XB-PEV
 * (Chetumal) y eligió «Turbosina»; el PEV solo carga AVGAS. El alta y el
 * PATCH ajustan la carga GAS al combustible del avión VIGENTE: vacío ⇒ se
 * rellena; distinto ⇒ se corrige con nota «⚠ … — revisar», visto bueno y
 * aviso a oficina (mismo canal que la matrícula). Sin la migración, todo
 * como el 0.0.55.
 *
 * El PostgREST falso responde por TABLA y por la forma de la consulta
 * (select, filtros, terminal) y registra cada consulta completa.
 */
const PEV = '11111111-1111-4111-8111-111111111111';
const N621TX = '22222222-2222-4222-8222-222222222222';
const N4142R = '55555555-5555-4555-8555-555555555555';
const VUELO_280 = '33333333-3333-4333-8333-333333333333';
const VUELO_281 = '66666666-6666-4666-8666-666666666666';
/** Tramo CTM→CUN del vuelo #280 que voló el N621TX (vuelo multi-avión). */
const TRAMO_N621 = '77777777-7777-4777-8777-777777777777';
const FLOTA = [
  { id: PEV, matricula: 'XB-PEV', combustible: 'AVGAS' },
  { id: N621TX, matricula: 'N621TX', combustible: 'TURBOSINA' },
  { id: N4142R, matricula: 'N4142R', combustible: 'AVGAS' },
];
/** Avión principal de cada vuelo (el #280 y el #281 son del PEV). */
const VUELOS: Record<string, { folio: number; aeronave_id: string | null }> = {
  [VUELO_280]: { folio: 280, aeronave_id: PEV },
  [VUELO_281]: { folio: 281, aeronave_id: PEV },
};
/** Tramos: el del N621TX pertenece al vuelo #280. */
const ESCALAS: Record<
  string,
  { vuelo_id: string; aeronave_id: string | null; o: string; d: string }
> = {
  [TRAMO_N621]: {
    vuelo_id: VUELO_280,
    aeronave_id: N621TX,
    o: 'CTM',
    d: 'CUN',
  },
};
const matriculaDe = (id: string | null) =>
  FLOTA.find((a) => a.id === id)?.matricula ?? null;
const LINEA_PEV =
  '⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar';

type Op = { m: string; a: unknown[] };
type Consulta = { tabla: string; ops: Op[]; fin: 'then' | 'maybeSingle' };
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string };
};

function armar(
  opts: { sinColumna?: boolean; actual?: Record<string, unknown> } = {},
) {
  const consultas: Consulta[] = [];
  const responder = (c: Consulta): Resultado => {
    const op = (m: string) => c.ops.find((o) => o.m === m);
    const sel = (op('select')?.a[0] as string | undefined) ?? '';
    if (c.tabla === 'aeronave') {
      if (sel === 'combustible') {
        return opts.sinColumna
          ? {
              data: null,
              error: {
                code: '42703',
                message: 'column aeronave.combustible does not exist',
              },
            }
          : { data: [], error: null };
      }
      if (c.fin === 'maybeSingle') {
        const id = op('eq')?.a[1];
        return { data: FLOTA.find((a) => a.id === id) ?? null, error: null };
      }
      const conComb = sel.includes('combustible');
      return {
        data: FLOTA.map((a) =>
          conComb ? a : { id: a.id, matricula: a.matricula },
        ),
        error: null,
      };
    }
    // Tramo con sus embebidos (`resolverTramoGasto`): avión propio y el
    // del vuelo dueño, cada uno con su matrícula.
    if (c.tabla === 'escala' && c.fin === 'maybeSingle') {
      const id = op('eq')?.a[1] as string;
      const e = ESCALAS[id];
      if (!e) return { data: null, error: null };
      const vuelo = VUELOS[e.vuelo_id];
      return {
        data: {
          id,
          vuelo_id: e.vuelo_id,
          orden: 2,
          origen_iata: e.o,
          destino_iata: e.d,
          aeronave_id: e.aeronave_id,
          aeronave: e.aeronave_id
            ? { matricula: matriculaDe(e.aeronave_id) }
            : null,
          vuelo: {
            aeronave_id: vuelo.aeronave_id,
            aeronave: { matricula: matriculaDe(vuelo.aeronave_id) },
          },
        },
        error: null,
      };
    }
    if (c.tabla === 'vuelo' && c.fin === 'maybeSingle') {
      const id = op('eq')?.a[1] as string;
      const v = VUELOS[id];
      return {
        data: v ? { id, ...v, piloto_id: 'u-luis' } : null,
        error: null,
      };
    }
    if (c.tabla === 'gasto') {
      const ins = op('insert');
      if (ins && c.fin === 'maybeSingle') {
        return {
          data: { id: 'g-nuevo', ...(ins.a[0] as object) },
          error: null,
        };
      }
      const upd = op('update');
      if (upd && c.fin === 'maybeSingle') {
        return {
          data: { ...(opts.actual ?? {}), ...(upd.a[0] as object) },
          error: null,
        };
      }
      if (c.fin === 'maybeSingle') {
        return { data: opts.actual ?? null, error: null };
      }
    }
    return { data: c.fin === 'maybeSingle' ? null : [], error: null };
  };
  const supabase = {
    service: {
      from: (tabla: string) => {
        const c: Consulta = { tabla, ops: [], fin: 'then' };
        const q: Record<string, unknown> = {};
        for (const m of [
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
          'range',
          'limit',
          'insert',
          'update',
        ]) {
          q[m] = (...a: unknown[]) => {
            c.ops.push({ m, a });
            return q;
          };
        }
        q.maybeSingle = () => {
          c.fin = 'maybeSingle';
          consultas.push(c);
          return Promise.resolve(responder(c));
        };
        q.then = (
          resolve: (v: Resultado) => unknown,
          reject?: (e: unknown) => unknown,
        ) => {
          consultas.push(c);
          return Promise.resolve(responder(c)).then(resolve, reject);
        };
        return q;
      },
    },
  } as unknown as SupabaseService;
  const notifyRole = jest.fn().mockResolvedValue(undefined);
  const notifications = {
    notifyRole,
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const nada = {} as never;
  const configuracion = { numero: jest.fn().mockResolvedValue(1) } as never;
  const service = new ExpensesService(
    supabase,
    notifications,
    nada,
    nada,
    configuracion,
    nada,
    nada,
  );
  return {
    service,
    consultas,
    notifyRole,
  };
}

const insertado = (consultas: Consulta[]) =>
  consultas
    .find((c) => c.tabla === 'gasto' && c.ops.some((o) => o.m === 'insert'))
    ?.ops.find((o) => o.m === 'insert')?.a[0] as Record<string, unknown>;

const actualizado = (consultas: Consulta[]) =>
  consultas
    .find((c) => c.tabla === 'gasto' && c.ops.some((o) => o.m === 'update'))
    ?.ops.find((o) => o.m === 'update')?.a[0] as Record<string, unknown>;

const lecturasFlota = (consultas: Consulta[]) =>
  consultas.filter(
    (c) =>
      c.tabla === 'aeronave' &&
      c.ops.some((o) => o.m === 'select' && o.a[0] !== 'combustible'),
  );

/** Llamadas a `notifyRole` con su tipo (rol, aviso). */
const llamadas = (notifyRole: jest.Mock) =>
  notifyRole.mock.calls as Array<[string, { titulo?: string }]>;

/** Avisos de combustible (el «gasto_registrado» de siempre aparte). */
const avisosCombustible = (notifyRole: jest.Mock) =>
  llamadas(notifyRole).filter(
    (c) => c[1].titulo === 'Carga de combustible corregida',
  );

const HOY = new Date('2026-09-10T18:00:00Z'); // jueves, 13:00 Cancún

/** La captura REAL de Luis: vuelo #280, 74 L, Chetumal, «Turbosina». */
function cargaPev(extra: Partial<CreateGastoDto> = {}): CreateGastoDto {
  return {
    categoria: CategoriaGasto.GAS,
    monto: 2738.5,
    moneda: Moneda.MXN,
    fecha_gasto: '2026-09-10',
    medio_pago: MedioPago.EFECTIVO,
    vuelo_id: VUELO_280,
    litros: 74,
    lugar: 'CTM',
    tipo_combustible: TipoCombustible.TURBOSINA,
    client_request_id: '44444444-4444-4444-8444-444444444444',
    ...extra,
  };
}

describe('ExpensesService.create — combustible del avión', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(HOY));
  afterEach(() => jest.useRealTimers());

  it('caso XB-PEV #280: TURBOSINA heredando el avión del vuelo ⇒ AVGAS + nota + visto bueno + aviso a oficina', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(cargaPev(), 'u-luis', Rol.PILOTO);
    const p = insertado(consultas);
    expect(p).toMatchObject({
      aeronave_id: PEV,
      tipo_combustible: 'AVGAS',
      litros: 74,
      monto: 2738.5,
      requiere_visto_bueno: true,
      notas: LINEA_PEV,
    });
    const avisos = avisosCombustible(notifyRole);
    expect(avisos.map((c) => c[0])).toEqual([Rol.ADMIN, Rol.ANALISTA]);
    expect(avisos[0][1]).toEqual({
      tipo: 'alerta_sistema',
      titulo: 'Carga de combustible corregida',
      cuerpo:
        'Se capturó Turbosina pero el XB-PEV carga Gasavión (74 L · $2,738.50 MXN). Se guardó como Gasavión y quedó para revisión.',
      data: { gasto_id: 'g-nuevo', motivo: 'combustible_corregido' },
      link: '/admin/expenses',
    });
    // Sin el actor (como «gasto_registrado»): quien capturó no se avisa.
    expect(avisos.map((c) => (c as unknown[])[2])).toEqual([
      'u-luis',
      'u-luis',
    ]);
    // UNA lectura de flota (con la columna) además de la sonda.
    expect(lecturasFlota(consultas)).toHaveLength(1);
    expect(lecturasFlota(consultas)[0].ops[0].a[0]).toBe(
      'id, matricula, combustible',
    );
  });

  it('la nota se suma a las notas del piloto (al final)', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({ notas: 'Carga en Chetumal' }),
      'u-luis',
      Rol.PILOTO,
    );
    expect(insertado(consultas).notas).toBe(`Carga en Chetumal\n${LINEA_PEV}`);
  });

  it('las notas de la app «Combustible TURBOSINA · 74 L · …» se reescriben con el código del avión ANTES de la nota ⚠', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({
        notas: 'Combustible TURBOSINA · 74 L · CTM\nTarjeta ****0585',
      }),
      'u-luis',
      Rol.PILOTO,
    );
    expect(insertado(consultas).notas).toBe(
      `Combustible AVGAS · 74 L · CTM\nTarjeta ****0585\n${LINEA_PEV}`,
    );
  });

  it('sin corrección el renglón «Combustible …» no se toca (ni con «Combustible» a media línea)', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({
        tipo_combustible: TipoCombustible.AVGAS,
        notas: 'Combustible AVGAS · 74 L · CTM',
      }),
      'u-luis',
      Rol.PILOTO,
    );
    expect(insertado(consultas).notas).toBe('Combustible AVGAS · 74 L · CTM');
    const otro = armar();
    await otro.service.create(
      cargaPev({ notas: 'Ticket con Combustible TURBOSINA · 74 L' }),
      'u-luis',
      Rol.PILOTO,
    );
    expect(insertado(otro.consultas).notas).toBe(
      `Ticket con Combustible TURBOSINA · 74 L\n${LINEA_PEV}`,
    );
  });

  it('tipo vacío ⇒ se rellena con el del avión, SIN nota, visto bueno ni aviso', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(
      cargaPev({ tipo_combustible: undefined, aeronave_id: N621TX }),
      'u-admin',
      Rol.ADMIN,
    );
    const p = insertado(consultas);
    expect(p.tipo_combustible).toBe('TURBOSINA');
    expect(p.requiere_visto_bueno).toBe(false);
    expect(p.notas).toBeUndefined();
    expect(avisosCombustible(notifyRole)).toHaveLength(0);
  });

  it('coincide con el avión ⇒ nada cambia', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(
      cargaPev({ tipo_combustible: TipoCombustible.AVGAS }),
      'u-luis',
      Rol.PILOTO,
    );
    const p = insertado(consultas);
    expect(p.tipo_combustible).toBe('AVGAS');
    expect(p.requiere_visto_bueno).toBe(false);
    expect(p.notas).toBeUndefined();
    expect(avisosCombustible(notifyRole)).toHaveLength(0);
  });

  it('el avión no aparece en la lectura de flota ⇒ se guarda tal cual', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({
        vuelo_id: undefined,
        aeronave_id: '99999999-9999-4999-8999-999999999999',
      }),
      'u-admin',
      Rol.ADMIN,
    );
    const p = insertado(consultas);
    expect(p.tipo_combustible).toBe('TURBOSINA');
    expect(p.requiere_visto_bueno).toBe(false);
  });

  it('carga masiva (notificar:false) ⇒ corrige y marca, pero sin push', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(
      cargaPev({ vuelo_id: undefined, aeronave_id: PEV }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(insertado(consultas)).toMatchObject({
      tipo_combustible: 'AVGAS',
      requiere_visto_bueno: true,
    });
    expect(notifyRole).not.toHaveBeenCalled();
  });

  it('carga masiva: la fila corregida también deja el renglón «Combustible …» con el código del avión', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({
        vuelo_id: undefined,
        aeronave_id: PEV,
        notas: 'Combustible TURBOSINA · factura A-123',
      }),
      'u-admin',
      Rol.ADMIN,
      { notificar: false },
    );
    expect(insertado(consultas).notas).toBe(
      `Combustible AVGAS · factura A-123\n${LINEA_PEV}`,
    );
  });

  it('con matrícula leída por la IA: UNA sola lectura de flota sirve a las dos validaciones', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(
      cargaPev({ valor_ia_extraido: { matricula: 'N621TX' } }),
      'u-luis',
      Rol.PILOTO,
    );
    const p = insertado(consultas);
    expect(p.tipo_combustible).toBe('AVGAS');
    expect(String(p.notas)).toContain(
      '⚠ el comprobante trae la matrícula N621TX pero el gasto quedó en XB-PEV — revisar',
    );
    expect(String(p.notas)).toContain(LINEA_PEV);
    expect(lecturasFlota(consultas)).toHaveLength(1);
    const titulos = llamadas(notifyRole).map((c) => c[1].titulo);
    expect(titulos).toContain('Matrícula del comprobante no coincide');
    expect(titulos).toContain('Carga de combustible corregida');
  });

  it('con TRAMO: el avión sale del tramo (N621TX) y la TURBOSINA capturada se respeta', async () => {
    const { service, consultas, notifyRole } = armar();
    await service.create(
      cargaPev({ vuelo_id: undefined, escala_id: TRAMO_N621 }),
      'u-luis',
      Rol.PILOTO,
    );
    const p = insertado(consultas);
    expect(p).toMatchObject({
      aeronave_id: N621TX,
      vuelo_id: VUELO_280,
      escala_id: TRAMO_N621,
      tipo_combustible: 'TURBOSINA',
      requiere_visto_bueno: false,
    });
    expect(p.notas).toBeUndefined();
    expect(avisosCombustible(notifyRole)).toHaveLength(0);
  });

  it('avión EXPLÍCITO distinto al del tramo: el combustible es el del TRAMO (ahí cuenta el gasto en balance y reparto)', async () => {
    const { service, consultas } = armar();
    // El piloto capturó bien TURBOSINA en el tramo del N621TX aunque dejó
    // el PEV como avión: NO se «corrige» a AVGAS.
    await service.create(
      cargaPev({ escala_id: TRAMO_N621, aeronave_id: PEV }),
      'u-luis',
      Rol.PILOTO,
    );
    const p = insertado(consultas);
    expect(p.aeronave_id).toBe(PEV);
    expect(p.tipo_combustible).toBe('TURBOSINA');
    expect(String(p.notas)).toContain('lo voló N621TX');
    expect(String(p.notas)).not.toContain('se corrigió');
    // Y si eligió AVGAS, se corrige al del tramo, con su matrícula.
    const otro = armar();
    await otro.service.create(
      cargaPev({
        escala_id: TRAMO_N621,
        aeronave_id: PEV,
        tipo_combustible: TipoCombustible.AVGAS,
      }),
      'u-luis',
      Rol.PILOTO,
    );
    const q = insertado(otro.consultas);
    expect(q.tipo_combustible).toBe('TURBOSINA');
    expect(q.requiere_visto_bueno).toBe(true);
    expect(String(q.notas)).toContain(
      '⚠ se capturó Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
    );
  });

  it('otra categoría no se toca ni lee la flota', async () => {
    const { service, consultas } = armar();
    await service.create(
      cargaPev({ categoria: CategoriaGasto.OPERACIONES }),
      'u-admin',
      Rol.ADMIN,
    );
    expect(insertado(consultas).tipo_combustible).toBe('TURBOSINA');
    expect(consultas.filter((c) => c.tabla === 'aeronave')).toHaveLength(0);
  });

  it('SIN la migración: tal cual, sin nota y sin leer la flota', async () => {
    const { service, consultas, notifyRole } = armar({ sinColumna: true });
    await service.create(cargaPev(), 'u-luis', Rol.PILOTO);
    const p = insertado(consultas);
    expect(p.tipo_combustible).toBe('TURBOSINA');
    expect(p.requiere_visto_bueno).toBe(false);
    expect(p.notas).toBeUndefined();
    expect(lecturasFlota(consultas)).toHaveLength(0);
    expect(avisosCombustible(notifyRole)).toHaveLength(0);
  });
});

describe('ExpensesService.update — combustible contra el avión VIGENTE', () => {
  const GAS_PEV = {
    id: 'g-1',
    categoria: 'GAS',
    aeronave_id: PEV,
    vuelo_id: null,
    escala_id: null,
    monto: 2738.5,
    moneda: 'MXN',
    medio_pago: 'EFECTIVO',
    tipo_combustible: 'AVGAS',
    notas: 'Carga en Chetumal',
    requiere_visto_bueno: false,
  };

  it('mover la carga del PEV al N621TX ⇒ TURBOSINA + nota «el gasto traía» + visto bueno', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update('g-1', { aeronave_id: N621TX }, 'u-admin', Rol.ADMIN);
    expect(actualizado(consultas)).toMatchObject({
      aeronave_id: N621TX,
      tipo_combustible: 'TURBOSINA',
      requiere_visto_bueno: true,
      notas:
        'Carga en Chetumal\n⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
    });
  });

  it('la oficina manda TURBOSINA sobre el PEV ⇒ se queda AVGAS, nota y visto bueno', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.TURBOSINA },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas)).toMatchObject({
      tipo_combustible: 'AVGAS',
      requiere_visto_bueno: true,
      notas: `Carga en Chetumal\n${LINEA_PEV}`,
    });
  });

  it('repetir el MISMO PATCH no duplica la nota', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        notas: `Carga en Chetumal\n${LINEA_PEV}`,
        requiere_visto_bueno: true,
      },
    });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.TURBOSINA },
      'u-admin',
      Rol.ADMIN,
    );
    const u = actualizado(consultas);
    expect(u.tipo_combustible).toBe('AVGAS');
    expect(u).not.toHaveProperty('notas');
    expect(u.requiere_visto_bueno).toBe(true);
  });

  it('con notas en el mismo PATCH, la línea va después de ellas', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update(
      'g-1',
      {
        tipo_combustible: TipoCombustible.TURBOSINA,
        notas: 'Ticket 0585',
      },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas).notas).toBe(`Ticket 0585\n${LINEA_PEV}`);
  });

  it('la corrección reescribe el renglón «Combustible …» de la app con el tipo del avión', async () => {
    const { service, consultas } = armar({
      actual: { ...GAS_PEV, notas: 'Combustible AVGAS · 74 L · CTM' },
    });
    await service.update('g-1', { aeronave_id: N621TX }, 'u-admin', Rol.ADMIN);
    expect(actualizado(consultas)).toMatchObject({
      tipo_combustible: 'TURBOSINA',
      requiere_visto_bueno: true,
      notas:
        'Combustible TURBOSINA · 74 L · CTM\n⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
    });
  });

  it('tipo null ⇒ se rellena con el del avión, sin nota ni visto bueno', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update(
      'g-1',
      { tipo_combustible: null } as unknown as UpdateGastoDto,
      'u-admin',
      Rol.ADMIN,
    );
    const u = actualizado(consultas);
    expect(u.tipo_combustible).toBe('AVGAS');
    expect(u).not.toHaveProperty('notas');
    expect(u).not.toHaveProperty('requiere_visto_bueno');
  });

  it('el mismo tipo del avión ⇒ nada que corregir', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.AVGAS },
      'u-admin',
      Rol.ADMIN,
    );
    const u = actualizado(consultas);
    expect(u.tipo_combustible).toBe('AVGAS');
    expect(u).not.toHaveProperty('requiere_visto_bueno');
    expect(u).not.toHaveProperty('notas');
  });

  it('un PATCH que no toca combustible ni avión NO lee la flota', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update('g-1', { lugar: 'CTM' }, 'u-admin', Rol.ADMIN);
    expect(consultas.filter((c) => c.tabla === 'aeronave')).toHaveLength(0);
    expect(actualizado(consultas)).not.toHaveProperty('tipo_combustible');
  });

  it('un gasto que NO es GAS no se toca', async () => {
    const { service, consultas } = armar({
      actual: { ...GAS_PEV, categoria: 'OPERACIONES' },
    });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.TURBOSINA },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas).tipo_combustible).toBe('TURBOSINA');
    expect(consultas.filter((c) => c.tabla === 'aeronave')).toHaveLength(0);
  });

  it('cambiar SOLO el tramo hereda su avión (N621TX) y re-aplica la regla', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV });
    await service.update(
      'g-1',
      { escala_id: TRAMO_N621 },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas)).toMatchObject({
      escala_id: TRAMO_N621,
      vuelo_id: VUELO_280,
      aeronave_id: N621TX,
      tipo_combustible: 'TURBOSINA',
      requiere_visto_bueno: true,
      notas:
        'Carga en Chetumal\n⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
    });
  });

  it('cambiar SOLO el vuelo (tramo viejo auto-limpiado) hereda el avión del vuelo nuevo', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        aeronave_id: N621TX,
        vuelo_id: VUELO_280,
        escala_id: TRAMO_N621,
        tipo_combustible: 'TURBOSINA',
      },
    });
    await service.update('g-1', { vuelo_id: VUELO_281 }, 'u-admin', Rol.ADMIN);
    expect(actualizado(consultas)).toMatchObject({
      vuelo_id: VUELO_281,
      escala_id: null,
      aeronave_id: PEV,
      tipo_combustible: 'AVGAS',
      requiere_visto_bueno: true,
      notas:
        'Carga en Chetumal\n⚠ el gasto traía Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar',
    });
  });

  it('volver GAS un gasto de otra categoría con TURBOSINA en el PEV ⇒ AVGAS con nota', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        categoria: 'OPERACIONES',
        tipo_combustible: 'TURBOSINA',
      },
    });
    await service.update(
      'g-1',
      { categoria: CategoriaGasto.GAS },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas)).toMatchObject({
      categoria: 'GAS',
      tipo_combustible: 'AVGAS',
      requiere_visto_bueno: true,
      notas:
        'Carga en Chetumal\n⚠ el gasto traía Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar',
    });
  });

  it('caso #280 al revés: la carga ya corregida en el PEV se mueve al N621TX ⇒ vuelve a TURBOSINA, se retira la nota vieja y no se pide otro visto bueno', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        notas: `Carga en Chetumal\n${LINEA_PEV}`,
        requiere_visto_bueno: true,
      },
    });
    await service.update('g-1', { aeronave_id: N621TX }, 'u-admin', Rol.ADMIN);
    const u = actualizado(consultas);
    expect(u).toMatchObject({
      aeronave_id: N621TX,
      tipo_combustible: 'TURBOSINA',
      notas: 'Carga en Chetumal',
    });
    expect(u).not.toHaveProperty('requiere_visto_bueno');
  });

  it('caso #280 al revés con el renglón de la app: al retirar la nota vieja el renglón queda con el tipo FINAL', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        notas: `Combustible AVGAS · 74 L · CTM\n${LINEA_PEV}`,
        requiere_visto_bueno: true,
      },
    });
    await service.update('g-1', { aeronave_id: N621TX }, 'u-admin', Rol.ADMIN);
    const u = actualizado(consultas);
    expect(u).toMatchObject({
      tipo_combustible: 'TURBOSINA',
      notas: 'Combustible TURBOSINA · 74 L · CTM',
    });
    expect(u).not.toHaveProperty('requiere_visto_bueno');
  });

  it('mover la carga corregida a otro avión AVGAS ⇒ la nota se reescribe con el avión nuevo (sin apilar)', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        notas: `Carga en Chetumal\n${LINEA_PEV}`,
        requiere_visto_bueno: true,
      },
    });
    await service.update('g-1', { aeronave_id: N4142R }, 'u-admin', Rol.ADMIN);
    const u = actualizado(consultas);
    expect(u.notas).toBe(
      'Carga en Chetumal\n⚠ se capturó Turbosina pero el N4142R carga Gasavión: se corrigió a Gasavión — revisar',
    );
    expect(u).not.toHaveProperty('tipo_combustible');
    expect(u).not.toHaveProperty('requiere_visto_bueno');
  });

  it('con tramo vigente, la regla usa el avión del TRAMO aunque el explícito sea otro', async () => {
    const { service, consultas } = armar({
      actual: {
        ...GAS_PEV,
        vuelo_id: VUELO_280,
        escala_id: TRAMO_N621,
        tipo_combustible: 'TURBOSINA',
      },
    });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.AVGAS },
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas)).toMatchObject({
      tipo_combustible: 'TURBOSINA',
      requiere_visto_bueno: true,
      notas:
        'Carga en Chetumal\n⚠ se capturó Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
    });
  });

  it('quitar el avión de una carga con vuelo ⇒ la regla usa el avión del vuelo', async () => {
    const { service, consultas } = armar({
      actual: { ...GAS_PEV, vuelo_id: VUELO_280 },
    });
    await service.update(
      'g-1',
      {
        aeronave_id: null,
        tipo_combustible: TipoCombustible.TURBOSINA,
      } as unknown as UpdateGastoDto,
      'u-admin',
      Rol.ADMIN,
    );
    expect(actualizado(consultas)).toMatchObject({
      aeronave_id: null,
      tipo_combustible: 'AVGAS',
      requiere_visto_bueno: true,
      notas: `Carga en Chetumal\n${LINEA_PEV}`,
    });
  });

  it('SIN la migración: el PATCH se guarda tal cual', async () => {
    const { service, consultas } = armar({ actual: GAS_PEV, sinColumna: true });
    await service.update(
      'g-1',
      { tipo_combustible: TipoCombustible.TURBOSINA },
      'u-admin',
      Rol.ADMIN,
    );
    const u = actualizado(consultas);
    expect(u.tipo_combustible).toBe('TURBOSINA');
    expect(u).not.toHaveProperty('requiere_visto_bueno');
  });
});
