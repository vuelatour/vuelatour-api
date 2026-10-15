import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  errorBd,
  sembrarPartes,
  TABLA_PARTES,
} from './conciliacion-partes.fixture-spec';
import {
  escrituras,
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from './conciliacion-postgrest.fixture-spec';
import {
  CANONICA,
  rpcOmisionCargos,
  RPC_CARGOS,
  type OpcionesOmision,
} from './omision-cargos.fixture-spec';

/**
 * «VARIOS CARGOS → UN GASTO» (14-oct-2026, API 0.0.77, invariante 76): los
 * candidatos por la SUMA y la liga atómica, contra el PostgREST falso con la
 * RPC `conciliacion_ligar_cargos_a_gasto` emulada.
 */
const USER = 'cccccccc-0000-4000-8000-000000000001';
const CTA = 'cta-mxn';
const CTA2 = 'cta-mxn-2';
const CTA_USD = 'cta-usd';
const id = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'GASTOS GNRAL',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
        activa: true,
      },
      {
        id: CTA2,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
        activa: true,
      },
      {
        id: CTA_USD,
        alias: 'HSBC DLLS',
        banco: 'HSBC',
        moneda: 'USD',
        tipo: 'BANCO',
        activa: true,
      },
    ],
    conciliacion_clasificacion: [],
    tarjeta_corporativa: [{ terminacion: '0577', activa: true }],
    proveedor: [{ id: 'prov-asa', nombre: 'ASA' }],
    gasto: [],
    movimiento_bancario: [],
    ...extra,
  };
}

const cargo = (
  n: number,
  fecha: string,
  monto: number,
  extra: Row = {},
): Row => ({
  id: id(n),
  cuenta_bancaria_id: CTA,
  fecha,
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: `ASA CANCUN ${n}`,
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  gastos_n: 0,
  cobros_n: 0,
  origen: 'IMPORTADO',
  notas: null,
  created_at: `${fecha}T12:00:00Z`,
  ...extra,
});

const gasto = (
  gid: string,
  monto: number,
  fecha: string,
  extra: Row = {},
): Row => ({
  id: gid,
  monto,
  moneda: 'MXN',
  fecha_gasto: fecha,
  medio_pago: 'TARJETA_CORP',
  conciliado: false,
  tc_gasto: null,
  tarjeta_terminacion: null,
  lugar: null,
  notas: null,
  categoria: 'GAS',
  vuelo_id: null,
  proveedor_id: 'prov-asa',
  folio_ticket: null,
  factura_recibida_id: null,
  ...extra,
});

function armar(
  db: Tablas,
  opts: { omision?: OpcionesOmision; fake?: OpcionesFake } = {},
) {
  sembrarPartes(db);
  const fake = fakePostgrest(db, {
    ...opts.fake,
    rpc: (n, a, d) => rpcOmisionCargos(d, n, a, opts.omision),
  });
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    fake.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, ...fake };
}

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    return {
      status: err.getStatus?.(),
      body: err.getResponse?.() as {
        message: string;
        error: string;
        details?: Record<string, unknown>;
      },
    };
  }
  throw new Error('se esperaba un rechazo');
}

/** Caso base: 3 cargos (3,000 + 4,000 + 2,700 = 9,700) del 22 al 24 sep. */
function tresCargos(gastos: Row[] = [], extraMovs: Row[] = []) {
  return mundo({
    movimiento_bancario: [
      cargo(1, '2026-09-22', 3000),
      cargo(2, '2026-09-23', 4000),
      cargo(3, '2026-09-24', 2700),
      ...extraMovs,
    ],
    gasto: gastos,
  });
}
const TRES = [id(1), id(2), id(3)];

describe('POST cargos/gastos-candidatos — la SUMA la calcula el API', () => {
  it('ordena CUBRE → PARCIAL → EXCEDE; fuera: otra moneda, efectivo y fuera de la ventana', async () => {
    const w = armar(
      tresCargos([
        gasto('g-excede', 9591.49, '2026-09-24'),
        gasto('g-parcial', 12000, '2026-09-23'),
        gasto('g-cubre', 9700.5, '2026-09-25'),
        gasto('g-usd', 9700, '2026-09-23', { moneda: 'USD' }),
        gasto('g-efectivo', 9700, '2026-09-23', { medio_pago: 'EFECTIVO' }),
        gasto('g-lejos', 9700, '2026-12-01'),
      ]),
    );
    const r = await w.svc.gastosCandidatosDeCargos({ movimiento_ids: TRES });
    expect(r.cargos).toEqual({
      ids: TRES,
      n: 3,
      suma: 9700,
      moneda: 'MXN',
      fecha_min: '2026-09-22',
      fecha_max: '2026-09-24',
      cuentas: [{ id: CTA, alias: 'GASTOS GNRAL' }],
      terminacion_comun: null,
    });
    expect(r.ventana).toEqual({ desde: '2026-08-23', hasta: '2026-10-24' });
    expect(
      r.candidatos.map((c) => [
        c.id,
        c.resultado,
        c.faltante_tras,
        c.excedente,
      ]),
    ).toEqual([
      ['g-cubre', 'CUBRE', 0.5, 0],
      ['g-parcial', 'PARCIAL', 2300, 0],
      ['g-excede', 'EXCEDE', 0, 108.51],
    ]);
    expect(r.candidatos[0]).toMatchObject({
      monto_vinculado: 0,
      faltante: 9700.5,
      medio_pago: 'TARJETA_CORP',
      no_bancario: false,
      proveedor: 'ASA',
    });
    expect(r.truncado).toBe(false);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('un gasto con pago previo se mide por lo que le FALTA', async () => {
    const db = tresCargos(
      [gasto('g-300', 10000, '2026-09-23')],
      [cargo(9, '2026-09-20', 300, { conciliado: true, gasto_id: 'g-300' })],
    );
    const w = armar(db);
    const r = await w.svc.gastosCandidatosDeCargos({ movimiento_ids: TRES });
    expect(r.candidatos[0]).toMatchObject({
      id: 'g-300',
      monto_vinculado: 300,
      faltante: 9700,
      resultado: 'CUBRE',
      faltante_tras: 0,
    });
  });

  it('la búsqueda por monto usa la MISMA regla de «Vincular gasto» (entero ⇒ [q, q+1))', async () => {
    const w = armar(
      tresCargos([
        gasto('g-cubre', 9700.5, '2026-09-25'),
        gasto('g-otro', 9701, '2026-09-25'),
      ]),
    );
    const r = await w.svc.gastosCandidatosDeCargos({
      movimiento_ids: TRES,
      q: '9700',
    });
    expect(r.candidatos.map((c) => c.id)).toEqual(['g-cubre']);
  });

  it('terminación común y cuentas; los cargos con SU propio gasto se avisan', async () => {
    const db = mundo({
      movimiento_bancario: [
        cargo(1, '2026-09-22', 3000, { referencia: '1234 5678 0000 0577' }),
        cargo(2, '2026-09-23', 4000, {
          referencia: '9999 5678 0000 0577',
          cuenta_bancaria_id: CTA2,
        }),
      ],
      gasto: [
        gasto('g-propio', 3000, '2026-09-22'),
        gasto('g-suma', 7000, '2026-09-23'),
      ],
    });
    const w = armar(db);
    const r = await w.svc.gastosCandidatosDeCargos({
      movimiento_ids: [id(1), id(2)],
    });
    expect(r.cargos.terminacion_comun).toBe('0577');
    expect(r.cargos.cuentas).toEqual([
      { id: CTA, alias: 'GASTOS GNRAL' },
      { id: CTA2, alias: 'EJE SCOTIA' },
    ]);
    expect(r.cargos_con_candidato_propio).toEqual([
      { id: id(1), motivo: 'SE_PUEDE_CRUZAR', candidatos_n: 1 },
    ]);
    expect(r.candidatos[0].id).toBe('g-suma');
  });

  it('CON candidatos también dice los excluidos de la suma (revisión del 14-oct-2026): el efectivo y el ya conciliado del mismo monto que «Créalo por la suma» duplicaría', async () => {
    const w = armar(
      tresCargos([
        // Otro gasto bancario del MISMO monto llena la lista…
        gasto('g-taxi', 9700, '2026-11-15', { categoria: 'TAXI' }),
        // …y antes escondía estos dos.
        gasto('g-efectivo', 9700, '2026-09-23', {
          medio_pago: 'EFECTIVO',
          categoria: 'COMIDA',
        }),
        gasto('g-conciliado', 9700, '2026-09-20', { conciliado: true }),
      ]),
    );
    for (const q of [undefined, '9700.00']) {
      const r = await w.svc.gastosCandidatosDeCargos({
        movimiento_ids: TRES,
        q,
        dias: 120,
      });
      expect(r.candidatos.map((c) => c.id)).toEqual(['g-taxi']);
      expect(r.excluidos?.map((g) => [g.motivo, g.n])).toEqual([
        ['EFECTIVO_U_OTRO_MEDIO', 1],
        ['YA_CONCILIADO', 1],
      ]);
      expect(r.excluidos?.[0].gastos[0].id).toBe('g-efectivo');
      expect(r.excluidos_monto).toBe(9700);
    }
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('sin candidatos: dice POR QUÉ (los excluidos por la suma)', async () => {
    const w = armar(
      tresCargos([
        gasto('g-efectivo', 9700, '2026-09-23', { medio_pago: 'EFECTIVO' }),
      ]),
    );
    const r = await w.svc.gastosCandidatosDeCargos({ movimiento_ids: TRES });
    expect(r.candidatos).toEqual([]);
    expect(r.excluidos?.[0]).toMatchObject({
      motivo: 'EFECTIVO_U_OTRO_MEDIO',
      n: 1,
    });
    expect(r.excluidos_monto).toBe(9700);
  });

  it('rechazos en el orden de la RPC', async () => {
    const db = mundo({
      movimiento_bancario: [
        cargo(1, '2026-09-22', 100),
        cargo(2, '2026-09-23', 200, { tipo: 'ABONO' }),
        cargo(3, '2026-09-24', 300, {
          conciliado: true,
          gasto_id: 'g-x',
          gastos_n: 1,
        }),
        cargo(4, '2026-09-24', 400, { cuenta_bancaria_id: CTA_USD }),
        cargo(5, '2026-09-24', 500, { cuenta_bancaria_id: 'cta-fantasma' }),
      ],
    });
    const w = armar(db);
    const uno = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1)] }),
    );
    expect([uno.status, uno.body.error, uno.body.message]).toEqual([
      400,
      'LOTE_INVALIDO',
      'Elige de 2 a 50 cargos sin repetir (con uno, usa «Vincular gasto» del menú ⋯).',
    ]);
    const falta = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1), id(9)] }),
    );
    expect([falta.status, falta.body.error, falta.body.details]).toEqual([
      404,
      'MOVIMIENTO_NO_EXISTE',
      { faltan: [id(9)] },
    ]);
    const abono = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1), id(2)] }),
    );
    expect([abono.status, abono.body.error, abono.body.message]).toEqual([
      400,
      'SOLO_CARGOS',
      'Solo los cargos pagan un gasto: quita el abono de la selección.',
    ]);
    const ocupado = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1), id(3)] }),
    );
    expect([ocupado.status, ocupado.body.error]).toEqual([
      409,
      'MOVIMIENTO_NO_PENDIENTE',
    ]);
    expect(ocupado.body.message).toBe(
      'No se vinculó ningún cargo: 1 de los 2 ya no está pendiente — 24 sep · ASA CANCUN 3 $300.00 (ya está vinculado a un gasto). Quítalo de la selección y vuelve a intentarlo.',
    );
    const monedas = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1), id(4)] }),
    );
    expect([monedas.status, monedas.body.error, monedas.body.message]).toEqual([
      409,
      'CARGOS_MONEDA_DISTINTA',
      'Los cargos son de cuentas en MXN y USD: un gasto se paga en una sola moneda.',
    ]);
    const sinMoneda = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: [id(1), id(5)] }),
    );
    expect([sinMoneda.status, sinMoneda.body.error]).toEqual([
      503,
      'CUENTA_SIN_MONEDA',
    ]);
  });

  it('sin la migración de partes ⇒ 503 CONCILIACION_PARTES_NO_DISPONIBLE', async () => {
    const w = armar(tresCargos(), {
      fake: { ausentes: { movimiento_bancario: ['gastos_n'] } },
    });
    const r = await rechazo(
      w.svc.gastosCandidatosDeCargos({ movimiento_ids: TRES }),
    );
    expect([r.status, r.body.error]).toEqual([
      503,
      'CONCILIACION_PARTES_NO_DISPONIBLE',
    ]);
  });
});

describe('POST gastos/:id/cargos — la liga atómica', () => {
  it('liga los 3 cargos (una parte por cargo, |monto|) y la BD recalcula el gasto', async () => {
    const db = tresCargos([gasto('g-1', 9700, '2026-09-24')]);
    const w = armar(db);
    const r = await w.svc.ligarCargosAGasto('g-1', [id(3), id(1), id(2)], USER);
    expect(r).toMatchObject({
      gasto_id: 'g-1',
      idempotente: false,
      nuevos: TRES,
      partes: [
        { movimiento_id: id(1), monto_parte: 3000, moneda: 'MXN' },
        { movimiento_id: id(2), monto_parte: 4000, moneda: 'MXN' },
        { movimiento_id: id(3), monto_parte: 2700, moneda: 'MXN' },
      ],
      gasto_estado: {
        monto: 9700,
        moneda: 'MXN',
        n_partes: 3,
        monto_vinculado: 9700,
        faltante: 0,
        cubierto: true,
      },
    });
    expect(db.gasto[0].conciliado).toBe(true);
    expect(db[TABLA_PARTES]).toHaveLength(3);
    // Relectura en el orden de la petición, con su `omision` y su liga.
    expect(
      r.movimientos.map((m) => [m.id, m.conciliado, m.gasto_id, m.omision]),
    ).toEqual([
      [id(3), true, 'g-1', null],
      [id(1), true, 'g-1', null],
      [id(2), true, 'g-1', null],
    ]);
    // UNA llamada a la RPC (jamás la G de un cargo encadenada).
    const llamadas = w.rpcs.filter((x) => x.nombre === RPC_CARGOS);
    expect(llamadas).toEqual([
      {
        nombre: RPC_CARGOS,
        args: {
          p_gasto_id: 'g-1',
          p_movimiento_ids: [id(3), id(1), id(2)],
          p_actor: USER,
        },
      },
    ]);
    expect(w.rpcs.map((x) => x.nombre)).not.toContain(
      'conciliacion_ligar_cargo_gastos',
    );
  });

  it('reenviar los mismos cargos es idempotente (nada nuevo)', async () => {
    const db = tresCargos([gasto('g-1', 9700, '2026-09-24')]);
    const w = armar(db);
    await w.svc.ligarCargosAGasto('g-1', TRES, USER);
    const r = await w.svc.ligarCargosAGasto('g-1', TRES, USER);
    expect(r).toMatchObject({ idempotente: true, nuevos: [] });
    expect(r.partes).toHaveLength(3);
    expect(db[TABLA_PARTES]).toHaveLength(3);
  });

  it('pagos parciales: el gasto queda parcial y acepta otro lote después', async () => {
    const db = mundo({
      movimiento_bancario: [
        cargo(1, '2026-09-22', 100),
        cargo(2, '2026-09-22', 100),
        cargo(3, '2026-09-23', 50),
        cargo(4, '2026-09-23', 50),
      ],
      gasto: [gasto('g-300', 300, '2026-09-22')],
    });
    const w = armar(db);
    const a = await w.svc.ligarCargosAGasto('g-300', [id(1), id(2)], USER);
    expect(a.gasto_estado).toMatchObject({
      cubierto: false,
      faltante: 100,
      monto_vinculado: 200,
    });
    expect(db.gasto[0].conciliado).toBe(false);
    const b = await w.svc.ligarCargosAGasto('g-300', [id(3), id(4)], USER);
    expect(b.gasto_estado).toMatchObject({
      cubierto: true,
      faltante: 0,
      n_partes: 4,
    });
    expect(db.gasto[0].conciliado).toBe(true);
  });

  it('CARGOS_EXCEDEN_GASTO con el texto exacto (y nada escrito)', async () => {
    const db = tresCargos([gasto('g-1', 9591.49, '2026-09-24')]);
    const w = armar(db);
    const r = await rechazo(w.svc.ligarCargosAGasto('g-1', TRES, USER));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('CARGOS_EXCEDEN_GASTO');
    expect(r.body.message).toBe(
      'Los 3 cargos suman $9,700.00 y al gasto le faltan $9,591.49 (vale $9,591.49): se pasarían por $108.51 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
    );
    expect(db[TABLA_PARTES]).toHaveLength(0);
  });

  it('moneda del gasto, medio no bancario, BODEGA, cubierto en otra moneda y gasto inexistente', async () => {
    const db = tresCargos(
      [
        gasto('g-usd', 9700, '2026-09-24', { moneda: 'USD' }),
        gasto('g-efectivo', 9700, '2026-09-24', { medio_pago: 'EFECTIVO' }),
        gasto('g-bodega', 9700, '2026-09-28', { medio_pago: 'BODEGA' }),
        gasto('g-cruzado', 9700, '2026-09-24'),
      ],
      [cargo(8, '2026-09-20', 170000, { cuenta_bancaria_id: CTA_USD })],
    );
    // Un cargo de OTRA moneda ya cubre g-cruzado 1 ↔ 1.
    db[TABLA_PARTES] = [
      {
        movimiento_id: id(8),
        gasto_id: 'g-cruzado',
        monto_parte: 170000,
        moneda: 'USD',
      },
    ];
    const w = armar(db);
    const usd = await rechazo(w.svc.ligarCargosAGasto('g-usd', TRES, USER));
    expect([usd.status, usd.body.error, usd.body.message]).toEqual([
      409,
      'LOTE_MONEDA_DISTINTA',
      'El gasto está en USD y los cargos en MXN: una compra en dólares pagada en pesos se vincula con UN solo cargo (menú ⋯ del cargo → Vincular gasto).',
    ]);
    const ef = await rechazo(w.svc.ligarCargosAGasto('g-efectivo', TRES, USER));
    expect([ef.status, ef.body.error, ef.body.message]).toEqual([
      409,
      'GASTO_NO_BANCARIO',
      'El gasto se pagó con Efectivo, que no pasa por el banco: se vincula cargo por cargo con su justificación (menú ⋯ → Vincular gasto → «Incluir gastos en efectivo y otros medios»).',
    ]);
    const bod = await rechazo(w.svc.ligarCargosAGasto('g-bodega', TRES, USER));
    expect([bod.status, bod.body.error]).toEqual([409, 'GASTO_BODEGA']);
    expect(bod.body.message).toContain('28 sep');
    const cru = await rechazo(w.svc.ligarCargosAGasto('g-cruzado', TRES, USER));
    expect([cru.status, cru.body.error, cru.body.message]).toEqual([
      409,
      'GASTO_YA_CUBIERTO',
      'Ese gasto ya está conciliado 1 a 1 con un cargo en otra moneda: no admite más cargos.',
    ]);
    const nada = await rechazo(w.svc.ligarCargosAGasto('g-nada', TRES, USER));
    expect([nada.status, nada.body.error, nada.body.message]).toEqual([
      404,
      'GASTO_NO_EXISTE',
      'Ese gasto ya no existe: recarga la página.',
    ]);
    expect(db[TABLA_PARTES]).toHaveLength(1);
  });

  it('un cargo ya ocupado (o OMITIDO) aborta TODO con su estado y la moneda de su cuenta', async () => {
    const db = tresCargos([gasto('g-1', 9700, '2026-09-24')]);
    db.conciliacion_clasificacion.push({
      id: 'c-omit',
      nombre: CANONICA,
      activo: true,
    });
    Object.assign(db.movimiento_bancario[1], {
      conciliado: true,
      clasificacion_id: 'c-omit',
      notas: 'Omitido de la conciliación: duplicado — Ale, 14-oct-2026',
    });
    const w = armar(db);
    const r = await rechazo(w.svc.ligarCargosAGasto('g-1', TRES, USER));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MOVIMIENTO_NO_PENDIENTE');
    expect(r.body.message).toBe(
      'No se vinculó ningún cargo: 1 de los 3 ya no está pendiente — 23 sep · ASA CANCUN 2 $4,000.00 (ya está omitido). Quítalo de la selección y vuelve a intentarlo.',
    );
    expect(r.body.details).toMatchObject({
      gasto_id: 'g-1',
      movimientos: [{ id: id(2), estado: 'OMITIDO', moneda: 'MXN' }],
    });
    expect(db[TABLA_PARTES]).toHaveLength(0);
  });

  it('lista inválida (sin RPC), cargos inexistentes, abonos y monedas', async () => {
    const db = tresCargos(
      [gasto('g-1', 9700, '2026-09-24')],
      [
        cargo(5, '2026-09-24', 10, { tipo: 'ABONO' }),
        cargo(6, '2026-09-24', 10, { cuenta_bancaria_id: CTA_USD }),
      ],
    );
    const w = armar(db);
    const uno = await rechazo(w.svc.ligarCargosAGasto('g-1', [id(1)], USER));
    expect([uno.status, uno.body.error]).toEqual([400, 'LOTE_INVALIDO']);
    expect(w.rpcs.filter((x) => x.nombre === RPC_CARGOS)).toHaveLength(0);
    const falta = await rechazo(
      w.svc.ligarCargosAGasto('g-1', [id(1), id(9)], USER),
    );
    expect([falta.status, falta.body.details]).toEqual([
      404,
      { faltan: [id(9)] },
    ]);
    const ab = await rechazo(
      w.svc.ligarCargosAGasto('g-1', [id(1), id(5)], USER),
    );
    expect([ab.status, ab.body.error]).toEqual([400, 'SOLO_CARGOS']);
    const mon = await rechazo(
      w.svc.ligarCargosAGasto('g-1', [id(1), id(6)], USER),
    );
    expect([mon.status, mon.body.error]).toEqual([
      409,
      'CARGOS_MONEDA_DISTINTA',
    ]);
  });

  it('interbloqueo ⇒ 409 CONFLICTO_CONCURRENTE; un error desconocido NO es «falta la migración»', async () => {
    const w = armar(tresCargos([gasto('g-1', 9700, '2026-09-24')]), {
      omision: {
        fallo: (n, a) =>
          n === RPC_CARGOS && (a.p_movimiento_ids as unknown[]).length > 0
            ? { code: '40P01', message: 'deadlock detected' }
            : null,
      },
    });
    const r = await rechazo(w.svc.ligarCargosAGasto('g-1', TRES, USER));
    expect([r.status, r.body.error, r.body.message]).toEqual([
      409,
      'CONFLICTO_CONCURRENTE',
      'Otra operación tocó estos movimientos al mismo tiempo: vuelve a intentarlo.',
    ]);
    const w2 = armar(tresCargos([gasto('g-1', 9700, '2026-09-24')]), {
      omision: {
        fallo: (n) =>
          n === RPC_CARGOS
            ? {
                code: '42883',
                message: 'operator does not exist: public.moneda = text',
              }
            : null,
      },
    });
    await expect(w2.svc.ligarCargosAGasto('g-1', TRES, USER)).rejects.toThrow(
      'operator does not exist: public.moneda = text',
    );
  });

  it('sin la migración 20261014000002 ⇒ 503 (solo la sonda llama a la BD)', async () => {
    const w = armar(tresCargos([gasto('g-1', 9700, '2026-09-24')]), {
      omision: { sinMigracion: true },
    });
    const r = await rechazo(w.svc.ligarCargosAGasto('g-1', TRES, USER));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      message: 'Esta opción todavía no está activa: avisa a sistemas.',
      error: 'CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE',
      details: { migracion: '20261014000002' },
    });
    expect(w.rpcs.map((x) => x.nombre)).toEqual([
      'conciliacion_omitir_movimientos',
    ]);
  });

  it("con `accion: 'crear'` (alta por la suma) los textos dicen «No se registró el gasto»", async () => {
    const w = armar(
      tresCargos([gasto('g-usd', 9700, '2026-09-24', { moneda: 'USD' })]),
    );
    const r = await rechazo(
      w.svc.ligarCargosAGasto('g-usd', TRES, USER, { accion: 'crear' }),
    );
    expect(r.body.message).toBe(
      'No se registró el gasto: el gasto está en USD y los cargos en MXN: una compra en dólares pagada en pesos se vincula con UN solo cargo (menú ⋯ del cargo → Vincular gasto).',
    );
  });

  it('el trigger de la BD (omitido) se traduce a 409, nunca 500', async () => {
    const w = armar(tresCargos([gasto('g-1', 9700, '2026-09-24')]), {
      omision: {
        fallo: (n, a) =>
          n === RPC_CARGOS && (a.p_movimiento_ids as unknown[]).length > 0
            ? errorBd('MOVIMIENTO_OMITIDO', 'omitido', { movimiento_id: id(1) })
            : null,
      },
    });
    const r = await rechazo(w.svc.ligarCargosAGasto('g-1', TRES, USER));
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
  });
});

describe('prevalidación del alta por la suma (espejo PURO, sin escribir)', () => {
  it('ok devuelve la moneda y la suma; los rechazos llevan «No se registró el gasto: »', async () => {
    const w = armar(tresCargos());
    expect(
      await w.svc.prevalidarCargosParaGastoNuevo(TRES, {
        moneda: 'MXN',
        monto: 9700,
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-09-24',
      }),
    ).toEqual({ moneda: 'MXN', suma: 9700 });
    const e1 = await rechazo(
      w.svc.prevalidarCargosParaGastoNuevo(TRES, {
        moneda: 'MXN',
        monto: 9000,
        medio_pago: 'TRANSFERENCIA',
      }),
    );
    expect([e1.status, e1.body.error]).toEqual([409, 'CARGOS_EXCEDEN_GASTO']);
    expect(e1.body.message).toBe(
      'No se registró el gasto: los 3 cargos suman $9,700.00 y al gasto le faltan $9,000.00 (vale $9,000.00): se pasarían por $700.00 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
    );
    const e2 = await rechazo(
      w.svc.prevalidarCargosParaGastoNuevo(TRES, {
        moneda: 'MXN',
        monto: 9700,
        medio_pago: 'EFECTIVO',
      }),
    );
    expect(
      e2.body.message.startsWith(
        'No se registró el gasto: el gasto se pagó con Efectivo',
      ),
    ).toBe(true);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('un cargo ocupado: el texto del alta', async () => {
    const w = armar(tresCargos([], []));
    Object.assign(w.db.movimiento_bancario[0], {
      conciliado: true,
      gasto_id: 'g-x',
      gastos_n: 1,
    });
    const e = await rechazo(
      w.svc.prevalidarCargosParaGastoNuevo(TRES, {
        moneda: 'MXN',
        monto: 9700,
        medio_pago: 'TRANSFERENCIA',
      }),
    );
    expect(e.body.message).toBe(
      'No se registró el gasto: 1 de los 3 cargos ya no está pendiente — 22 sep · ASA CANCUN 1 $3,000.00 (ya está vinculado a un gasto). Cancela, quita esos cargos de la selección y vuelve a intentarlo.',
    );
  });
});
