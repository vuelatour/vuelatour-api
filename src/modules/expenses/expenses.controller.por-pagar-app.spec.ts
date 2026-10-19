// Módulos pesados que el controller y el servicio importan solo para
// inyección.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import type { SupabaseService } from '../supabase/supabase.service';
import type { UpdateGastoDto } from './dto/expenses.dto';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { Rol } from '../../common/types/auth.types';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * «YA LO PAGUÉ» DE LA APP (gastos por pagar, invariante 93) con el
 * controller y el servicio REALES sobre la BD en memoria (con la migración
 * 20261019000001, sin la del cierre). Casos de la revisión adversaria del
 * 19-oct-2026:
 *  - P5: el outbox sube tarde la corrección; la semana de CAPTURA de la
 *    fecha del pago se mide con el sello `capturado_en`, no con la llegada.
 *  - P6: reenviar un «Ya lo pagué» ya aplicado (respuesta perdida) es
 *    idempotente: 200 con la fila, una sola escritura, sin 403 ni 409.
 *  - P7: un por pagar VIGENTE no está en ninguna reposición de caja chica:
 *    corregirlo o borrarlo no choca con GASTO_EN_REPOSICION; marcarlo
 *    pagado con una fecha ya repuesta sí, con un texto que no dice «ya
 *    entró».
 *  - P8: el PATCH mínimo de un VISITANTE no reescribe la categoría.
 */

const PILOTO = 'u-piloto';
const VIS = 'u-vis';

const gasto = (id: string, extra: Fila = {}): Fila => ({
  id,
  categoria: 'OTRO',
  monto: 500,
  propina: 0,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-10-15',
  medio_pago: 'EFECTIVO',
  tarjeta_terminacion: null,
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  conciliado: false,
  por_pagar: false,
  compra_id: null,
  notas: null,
  fecha_hora_carga: null,
  usuario_captura_id: PILOTO,
  created_at: '2026-10-05T15:00:00.000Z',
  updated_at: '2026-10-05T15:00:00.000Z',
  ...extra,
});

function armar(
  gastos: Fila[],
  opts: { ultimaReposicion?: string | null } = {},
) {
  const f = fakeCierre(
    {
      usuario: [
        { id: PILOTO, nombre: 'Luis Piloto', gastos_sin_limite_hasta: null },
        { id: VIS, nombre: 'Visitante', gastos_sin_limite_hasta: null },
      ],
      gasto: gastos,
      aeronave: [{ id: 'av-1', matricula: 'N4142R', activa: true }],
    },
    { sinMigracion: true },
  );
  const cajaChica = {
    fechaUltimaReposicionDe: jest
      .fn()
      .mockResolvedValue(opts.ultimaReposicion ?? null),
  };
  const nada = {} as never;
  const service = new ExpensesService(
    { service: f.service } as unknown as SupabaseService,
    {
      notifyRole: jest.fn().mockResolvedValue(1),
      notifyUser: jest.fn().mockResolvedValue(true),
    } as never,
    nada,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    cajaChica as never,
    nada,
  );
  const ctrl = new ExpensesController(service, nada);
  return { f, service, ctrl, cajaChica };
}

const fila = (f: ReturnType<typeof fakeCierre>, id: string) =>
  (f.tablas.gasto ?? []).find((g) => g.id === id) as Fila;
const escrituras = (f: ReturnType<typeof fakeCierre>, id: string) =>
  f.escrituras.filter((e) => e.tabla === 'gasto' && e.valores.id === id);

async function error(p: Promise<unknown>): Promise<{
  status: number | null;
  code: string | null;
  message: string | null;
}> {
  try {
    await p;
  } catch (e) {
    const ex = e as {
      getStatus?: () => number;
      getResponse?: () => unknown;
      message?: string;
    };
    const r = ex.getResponse?.();
    const cuerpo =
      r && typeof r === 'object'
        ? (r as { error?: string; message?: string })
        : null;
    return {
      status: ex.getStatus?.() ?? null,
      code: cuerpo?.error ?? null,
      message:
        (typeof cuerpo?.message === 'string' ? cuerpo.message : null) ??
        ex.message ??
        null,
    };
  }
  throw new Error('se esperaba un rechazo');
}

const reloj = (iso: string) =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date(iso),
  });
afterEach(() => jest.useRealTimers());

const usuario = (userId: string, rol: Rol): AuthenticatedUser =>
  ({ userId, authId: `auth-${userId}`, nombre: userId, rol }) as never;
const piloto = usuario(PILOTO, Rol.PILOTO);
const visitante = usuario(VIS, Rol.VISITANTE);
const patch = (cuerpo: Record<string, unknown>) =>
  cuerpo as unknown as UpdateGastoDto;

describe('P5 — «Ya lo pagué» que el outbox sube después de la gracia', () => {
  // Capturado el jue 22-oct con fecha lun 26-oct; pagado (y tocado) el sáb
  // 24-oct sin señal; la gracia es 1 día (hasta el lunes).
  const g5 = () =>
    gasto('g5', {
      por_pagar: true,
      fecha_gasto: '2026-10-26',
      created_at: '2026-10-22T15:00:00.000Z',
      updated_at: '2026-10-22T15:00:00.000Z',
    });
  const cuerpo = (extra: Record<string, unknown> = {}) =>
    patch({
      por_pagar: false,
      fecha_gasto: '2026-10-24',
      if_updated_at: '2026-10-22T15:00:00.000Z',
      capturado_en: '2026-10-24T12:00:00-05:00',
      ...extra,
    });

  it('sube el MARTES 27: la semana se mide con el día del sello (sáb 24) ⇒ pagado con la fecha real', async () => {
    reloj('2026-10-27T15:00:00Z');
    const { ctrl, f } = armar([g5()]);
    await ctrl.update('g5', cuerpo(), piloto);
    expect(fila(f, 'g5')).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-24',
    });
  });

  it('pago ANTICIPADO del dom 25 de un gasto al 31, subido el mar 27 ⇒ pasa', async () => {
    reloj('2026-10-27T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g5b', {
        por_pagar: true,
        fecha_gasto: '2026-10-31',
        created_at: '2026-10-22T15:00:00.000Z',
        updated_at: '2026-10-22T15:00:00.000Z',
      }),
    ]);
    await ctrl.update(
      'g5b',
      cuerpo({
        fecha_gasto: '2026-10-25',
        capturado_en: '2026-10-25T12:00:00-05:00',
      }),
      piloto,
    );
    expect(fila(f, 'g5b')).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-25',
    });
  });

  it('SIN sello (en línea) la semana sigue siendo la de hoy ⇒ 400 de siempre y el gasto sigue por pagar', async () => {
    reloj('2026-10-27T15:00:00Z');
    const { ctrl, f } = armar([g5()]);
    const e = await error(
      ctrl.update('g5', cuerpo({ capturado_en: undefined }), piloto),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      'Los gastos se capturan dentro de su semana (lunes a domingo). El lunes aún puedes capturar los de la semana pasada; después ya solo los de la semana en curso.',
    );
    expect(fila(f, 'g5').por_pagar).toBe(true);
  });

  it('el sello no abre semanas viejas: un sello del día 24 no acepta una fecha de pago de la semana anterior', async () => {
    reloj('2026-10-27T15:00:00Z');
    const { ctrl, f } = armar([g5()]);
    const e = await error(
      ctrl.update('g5', cuerpo({ fecha_gasto: '2026-10-16' }), piloto),
    );
    expect(e.status).toBe(400);
    expect(escrituras(f, 'g5')).toHaveLength(0);
  });
});

describe('P6 — reenviar un «Ya lo pagué» que ya se aplicó', () => {
  it('FUERA de la ventana: el 2.º envío idéntico ⇒ 200 con la fila (sin 403) y UNA sola escritura', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g6', { por_pagar: true, fecha_gasto: '2026-10-15' }),
    ]);
    const cuerpo = () =>
      patch({
        por_pagar: false,
        fecha_gasto: '2026-10-20',
        if_updated_at: '2026-10-05T15:00:00.000Z',
        capturado_en: '2026-10-20T09:58:00-05:00',
      });
    await ctrl.update('g6', cuerpo(), piloto);
    expect(fila(f, 'g6').por_pagar).toBe(false);
    // El trigger tg_set_updated_at movió la versión.
    fila(f, 'g6').updated_at = '2026-10-20T15:00:01.000Z';
    const r = (await ctrl.update('g6', cuerpo(), piloto)) as Fila;
    expect(r).toMatchObject({
      id: 'g6',
      por_pagar: false,
      fecha_gasto: '2026-10-20',
      estado_pago: 'PAGADO',
    });
    expect(escrituras(f, 'g6')).toHaveLength(1);
  });

  it('DENTRO de la ventana: el 2.º envío ⇒ 200 (sin 409 CONFLICTO_VERSION) y una sola escritura', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g6b', {
        por_pagar: true,
        fecha_gasto: '2026-10-25',
        created_at: '2026-10-19T15:00:00.000Z',
        updated_at: '2026-10-19T15:00:00.000Z',
      }),
    ]);
    const cuerpo = () =>
      patch({
        por_pagar: false,
        fecha_gasto: '2026-10-20',
        if_updated_at: '2026-10-19T15:00:00.000Z',
        capturado_en: '2026-10-20T09:58:00-05:00',
      });
    await ctrl.update('g6b', cuerpo(), piloto);
    fila(f, 'g6b').updated_at = '2026-10-20T15:00:01.000Z';
    const r = (await ctrl.update('g6b', cuerpo(), piloto)) as Fila;
    expect(r).toMatchObject({ id: 'g6b', por_pagar: false });
    expect(escrituras(f, 'g6b')).toHaveLength(1);
  });

  it('el reenvío SIN fecha (la de hoy la puso el servidor) también es réplica', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g6c', { por_pagar: true, fecha_gasto: '2026-10-25' }),
    ]);
    await ctrl.update('g6c', patch({ por_pagar: false }), piloto);
    expect(fila(f, 'g6c').fecha_gasto).toBe('2026-10-20');
    await ctrl.update('g6c', patch({ por_pagar: false }), piloto);
    expect(escrituras(f, 'g6c')).toHaveLength(1);
  });

  it('con OTRA fecha ya no es réplica (cambiaría datos): fuera de la ventana ⇒ 403 y nada se escribe', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g6d', { por_pagar: false, fecha_gasto: '2026-10-20' }),
    ]);
    const e = await error(
      ctrl.update(
        'g6d',
        patch({ por_pagar: false, fecha_gasto: '2026-10-19' }),
        piloto,
      ),
    );
    expect(e).toMatchObject({ status: 403, code: 'GASTO_FUERA_DE_VENTANA' });
    expect(escrituras(f, 'g6d')).toHaveLength(0);
  });
});

describe('P7 — GASTO_EN_REPOSICION con gastos por pagar (caja chica)', () => {
  it('un VENCIDO por pagar (fuera del libro) con fecha ≤ última reposición se puede BORRAR', async () => {
    reloj('2026-10-19T15:00:00Z'); // lunes de gracia
    const { service } = armar(
      [
        gasto('g7', {
          por_pagar: true,
          fecha_gasto: '2026-10-17',
          created_at: '2026-10-15T15:00:00.000Z',
        }),
      ],
      { ultimaReposicion: '2026-10-19' },
    );
    // Lo que corre el DELETE de campo antes de `remove`.
    await expect(
      service.assertOwnEnVentana('g7', PILOTO, undefined),
    ).resolves.toBeUndefined();
  });

  it('…y CORREGIR (sigue por pagar) tampoco choca con el candado', async () => {
    reloj('2026-10-19T15:00:00Z');
    const { ctrl, f } = armar(
      [
        gasto('g7c', {
          por_pagar: true,
          fecha_gasto: '2026-10-17',
          created_at: '2026-10-15T15:00:00.000Z',
        }),
      ],
      { ultimaReposicion: '2026-10-19' },
    );
    await ctrl.update('g7c', patch({ notas: 'taxi al FBO' }), piloto);
    expect(fila(f, 'g7c')).toMatchObject({
      notas: 'taxi al FBO',
      por_pagar: true,
    });
  });

  it('«Ya lo pagué» con una fecha que la última reposición ya cubrió ⇒ 409 GASTO_EN_REPOSICION con el texto de la FECHA DEL PAGO', async () => {
    reloj('2026-10-19T17:00:00Z'); // lunes 12:00
    const { ctrl, f } = armar(
      [
        gasto('g7b', {
          por_pagar: true,
          fecha_gasto: '2026-10-19',
          created_at: '2026-10-17T15:00:00.000Z',
          updated_at: '2026-10-17T15:00:00.000Z',
        }),
      ],
      { ultimaReposicion: '2026-10-19' },
    );
    const e = await error(
      ctrl.update(
        'g7b',
        patch({
          por_pagar: false,
          fecha_gasto: '2026-10-19',
          if_updated_at: '2026-10-17T15:00:00.000Z',
          capturado_en: '2026-10-19T11:59:00-05:00',
        }),
        piloto,
      ),
    );
    expect(e).toEqual({
      status: 409,
      code: 'GASTO_EN_REPOSICION',
      message:
        'La fecha del pago (19/10/2026) ya quedó cubierta por la reposición del 19/10/2026 de tu caja chica: usa una fecha posterior o pide a oficina que lo marque pagado.',
    });
    expect(fila(f, 'g7b').por_pagar).toBe(true);
  });

  it('marcar pagado con OTRAS llaves (dentro de su semana) también mide la fecha del pago: sin hueco', async () => {
    reloj('2026-10-19T17:00:00Z');
    const { ctrl, f } = armar(
      [
        gasto('g7d', {
          por_pagar: true,
          fecha_gasto: '2026-10-25',
          created_at: '2026-10-19T15:00:00.000Z',
        }),
      ],
      { ultimaReposicion: '2026-10-19' },
    );
    const e = await error(
      ctrl.update(
        'g7d',
        patch({ por_pagar: false, fecha_gasto: '2026-10-19', notas: 'pagado' }),
        piloto,
      ),
    );
    expect(e.code).toBe('GASTO_EN_REPOSICION');
    expect(e.message).toContain('La fecha del pago (19/10/2026)');
    expect(escrituras(f, 'g7d')).toHaveLength(0);
  });

  it('un gasto PAGADO con fecha ≤ última reposición sigue con el candado y el texto de siempre', async () => {
    reloj('2026-10-19T15:00:00Z');
    const { ctrl } = armar(
      [
        gasto('g7e', {
          fecha_gasto: '2026-10-17',
          created_at: '2026-10-17T15:00:00.000Z',
        }),
      ],
      { ultimaReposicion: '2026-10-19' },
    );
    const e = await error(ctrl.update('g7e', patch({ notas: 'x' }), piloto));
    expect(e).toEqual({
      status: 409,
      code: 'GASTO_EN_REPOSICION',
      message:
        'Este gasto ya entró a una reposición de tu caja chica; pide el ajuste a oficina.',
    });
  });
});

describe('P8 — VISITANTE: «Ya lo pagué» fuera de su semana NO reescribe la categoría', () => {
  const cuerpo = () =>
    patch({
      por_pagar: false,
      fecha_gasto: '2026-10-20',
      if_updated_at: '2026-10-05T15:00:00.000Z',
      capturado_en: '2026-10-20T09:58:00-05:00',
    });

  it('la oficina lo pasó a PERSONAL_DUENO ⇒ se queda PERSONAL_DUENO (sin `categoria` en el UPDATE)', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g8', {
        usuario_captura_id: VIS,
        categoria: 'PERSONAL_DUENO',
        por_pagar: true,
        fecha_gasto: '2026-10-25',
      }),
    ]);
    await ctrl.update('g8', cuerpo(), visitante);
    expect(fila(f, 'g8')).toMatchObject({
      categoria: 'PERSONAL_DUENO',
      por_pagar: false,
      fecha_gasto: '2026-10-20',
    });
    const [w] = escrituras(f, 'g8');
    expect('categoria' in w.valores).toBe(false);
  });

  it('la oficina lo pasó a INDIRECTO con avión ⇒ 200 (antes: 400 «un gasto de visita no lleva…»)', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g8b', {
        usuario_captura_id: VIS,
        categoria: 'INDIRECTO',
        aeronave_id: 'av-1',
        por_pagar: true,
        fecha_gasto: '2026-10-25',
      }),
    ]);
    await ctrl.update('g8b', cuerpo(), visitante);
    expect(fila(f, 'g8b')).toMatchObject({
      categoria: 'INDIRECTO',
      aeronave_id: 'av-1',
      por_pagar: false,
    });
  });

  it('cualquier otra corrección del visitante (en su semana) sigue fijando VISITA', async () => {
    reloj('2026-10-20T15:00:00Z');
    const { ctrl, f } = armar([
      gasto('g8c', {
        usuario_captura_id: VIS,
        categoria: 'OTRO',
        created_at: '2026-10-19T15:00:00.000Z',
      }),
    ]);
    await ctrl.update('g8c', patch({ notas: 'comida' }), visitante);
    expect(fila(f, 'g8c').categoria).toBe('VISITA');
  });
});
