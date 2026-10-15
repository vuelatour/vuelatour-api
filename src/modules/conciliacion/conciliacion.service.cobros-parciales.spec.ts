import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  fakeCobrosParciales,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from './cobros-parciales.fixture-spec';

/**
 * UN COBRO, VARIOS ABONOS — VINCULAR Y CANDADOS (14-oct-2026, API 0.0.78,
 * invariante 77). Casos reales: las camionetas de Beh Kay (#315: $3,400
 * pagados con DOS SPEI de $1,700), el abono de $69,183 que pagó #315
 * ($68,205.55) y $977.45 de #332, los lotes de Villanueva (#277/#278) y los
 * abonos Paywise que no cuadran con la comisión provisionada (#293). Se
 * congela, contra una BD falsa que emula la migración 20261014000003 (A, B,
 * C, D, E, G y H traducidos del plpgsql) y la «BD vieja» (20261012000002):
 * - PATCH movimientos/:id/cobro por `cobro_id` (camino directo) y por
 *   `cobro_ids` (RPC): PARCIAL sin bandera, CONCILIADO, COBRO_YA_CONCILIADO
 *   (CUBIERTO / UN_SOLO_ABONO), ABONO_EXCEDE_COBRO con `sugeridos[]`,
 *   COMISION_NO_CUADRA, COBRO_MONEDA_DISTINTA (±2 % del T.C.),
 *   SOBRE_NO_CUADRA; lotes por FALTANTE; todo 409 SIN escribir;
 * - la respuesta con `cobros_estado[].cobro_estado` (la fila RELEÍDA) y, al
 *   desvincular, `cobros_liberados[]`;
 * - `corregir_comision` (escribe la comisión real y liga; 400
 *   CORREGIR_COMISION_NO_APLICA; si la liga falla después, la comisión
 *   queda y el 409 lo dice);
 * - candidatos-cobro con `al_vincular`, sugeridos (también fuera de los 60)
 *   y las capacidades;
 * - Paywise: la comisión real inferida por BRUTO antes de ligar y los lotes
 *   fuera de la auditoría (`movimientos_en_lote`);
 * - SIN la migración: el 2.º abono de un parcial ⇒ 503, de uno cubierto ⇒
 *   409, la pre-validación igual; el error REAL de la BD con la marca
 *   « [ABONO_NO_CUADRA]» ⇒ 409 es-MX sin la marca.
 */

const USER = 'u-oficina';
const CTA = 'cta-mxn';
const CTA_USD = 'cta-usd';
const CTA_PW = 'cta-paywise';

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-15',
  tipo: 'ABONO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: '2026-09-16T15:00:00Z',
  cobros_n: 0,
  updated_by: null,
  ...extra,
});

/** Abono YA ligado a UN cobro (espejo + su parte = |abono|). */
const ligado = (
  db: Tablas,
  id: string,
  monto: number,
  cobroId: string,
  extra: Row = {},
) => {
  db.movimiento_bancario.push(
    abono(id, monto, {
      conciliado: true,
      cobro_id: cobroId,
      cobros_n: 1,
      ...extra,
    }),
  );
  db.movimiento_bancario_cobro.push({
    movimiento_id: id,
    cobro_id: cobroId,
    monto_parte: monto,
    created_at: '2026-10-13T16:00:00Z',
    created_by: null,
  });
};

const cobro = (
  id: string,
  vueloId: string,
  monto: number,
  extra: Row = {},
): Row => ({
  id,
  vuelo_id: vueloId,
  monto,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  fecha_cobro: '2026-09-15T17:00:00Z',
  referencia: null,
  comision_banco_monto: null,
  comision_banco_pct: null,
  tc_usd_mxn: null,
  cobro_grupo_id: null,
  ...extra,
});

const vuelo = (folio: number, extra: Row = {}): Row => ({
  id: `v${folio}`,
  folio,
  fecha_vuelo: '2026-09-15T14:00:00Z',
  cliente_id: 'k-behkay',
  tc_usd_mxn: null,
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'EJE SCOTIA',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
      },
      {
        id: CTA_USD,
        alias: 'HSBC USD',
        banco: 'HSBC',
        moneda: 'USD',
        tipo: 'BANCO',
      },
      {
        id: CTA_PW,
        alias: 'Paywise',
        banco: 'Paywise',
        moneda: 'MXN',
        tipo: 'PASARELA',
      },
    ],
    cliente: [
      { id: 'k-behkay', nombre: 'Beh Kay' },
      { id: 'k-villa', nombre: 'Villanueva' },
    ],
    vuelo: [
      vuelo(315, { tc_usd_mxn: 17.15 }),
      vuelo(332),
      vuelo(277, { cliente_id: 'k-villa' }),
      vuelo(278, { cliente_id: 'k-villa' }),
      vuelo(293),
      vuelo(400, { tc_usd_mxn: 17 }),
    ],
    vuelo_grupo: [
      {
        id: 'g12',
        folio: 12,
        nombre: 'Boda',
        fecha_vuelo: '2026-09-15T14:00:00Z',
        cliente_id: 'k-behkay',
      },
    ],
    cobro_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    cobro_vuelo: [],
    conciliacion_clasificacion: [],
    tarjeta_corporativa: [],
    ...extra,
  };
}

function armar(db: Tablas, opts: OpcionesCobrosParciales = {}) {
  const f = fakeCobrosParciales(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, escrituras: f.escrituras };
}

/** El HttpException de una promesa que debe fallar (code, message, details). */
async function error(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  const r = (e as { getResponse?: () => unknown } | null)?.getResponse?.() as
    | { error?: string; message?: string; details?: Record<string, unknown> }
    | undefined;
  return {
    e,
    code: r?.error ?? null,
    message: r?.message ?? null,
    details: r?.details ?? null,
  };
}

const partesDe = (db: Tablas, cobroId: string) =>
  db.movimiento_bancario_cobro
    .filter((p) => p.cobro_id === cobroId)
    .map((p) => [p.movimiento_id, p.monto_parte]);

describe('Vincular — un cobro, varios abonos (camionetas de Beh Kay, #315 $3,400)', () => {
  const camionetas = () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400)],
      movimiento_bancario: [
        abono('m1', 1700, { fecha: '2026-09-15' }),
        abono('m2', 1700, { fecha: '2026-09-16' }),
        abono('m3', 100, { fecha: '2026-09-17' }),
      ],
    });
    return armar(db);
  };

  for (const camino of ['cobro_id', 'cobro_ids'] as const) {
    const liga = (id: string) =>
      camino === 'cobro_id' ? { cobro_id: id } : { cobro_ids: [id] };

    it(`${camino}: 1,700 ⇒ PARCIAL; 1,700 ⇒ completo; 100 ⇒ 409 COBRO_YA_CONCILIADO (CUBIERTO) sin escribir`, async () => {
      const { svc, db, escrituras } = camionetas();
      const r1 = await svc.linkCobro('m1', liga('c315'), USER);
      expect(partesDe(db, 'c315')).toEqual([['m1', 1700]]);
      // La fila RELEÍDA (los espejos los recalcula la BD después del UPDATE).
      expect(r1.cobros_n).toBe(1);
      expect(r1.cobro_id).toBe('c315');
      expect(r1.cobros_estado).toEqual([
        expect.objectContaining({
          cobro_id: 'c315',
          monto_parte: 1700,
          folio: 315,
          cliente: 'Beh Kay',
          cobro_estado: 'PARCIAL',
          cobro_neto: 3400,
          cobro_monto_vinculado: 1700,
          cobro_faltante: 1700,
          cobro_abonos_n: 1,
        }),
      ]);
      const r2 = await svc.linkCobro('m2', liga('c315'), USER);
      expect(partesDe(db, 'c315')).toEqual([
        ['m1', 1700],
        ['m2', 1700],
      ]);
      expect(r2.cobros_estado).toEqual([
        expect.objectContaining({
          cobro_estado: 'CONCILIADO',
          cobro_faltante: 0,
          cobro_abonos_n: 2,
        }),
      ]);
      const antes = escrituras().length;
      const r3 = await error(svc.linkCobro('m3', liga('c315'), USER));
      expect(r3.e).toBeInstanceOf(ConflictException);
      expect(r3.code).toBe('COBRO_YA_CONCILIADO');
      expect(r3.details).toMatchObject({
        cobro_id: 'c315',
        folio: 315,
        motivo: 'CUBIERTO',
        neto: 3400,
        suma_ligada: 3400,
        abonos_otros: 2,
        movimiento_ids: ['m1', 'm2'],
        movimiento_id: 'm1',
      });
      expect(r3.message).toBe(
        'El cobro del vuelo #315 ya está conciliado completo: $3,400.00 MXN con 2 abonos del banco (15 sep · $1,700.00 y 16 sep · $1,700.00). Si este abono es otro pago del mismo vuelo, regístralo como un cobro nuevo; si uno de los abonos se ligó por error, desvincúlalo en Conciliación.',
      );
      expect(escrituras().length).toBe(antes);
      expect(db.movimiento_bancario[2]).toMatchObject({
        conciliado: false,
        cobros_n: 0,
      });
    });
  }

  it('desvincular UNO de dos ⇒ cobros_liberados PARCIAL (faltan 1,700) y el otro abono intacto; el último ⇒ SIN_CONCILIAR', async () => {
    const { svc, db } = camionetas();
    await svc.linkCobro('m1', { cobro_id: 'c315' }, USER);
    await svc.linkCobro('m2', { cobro_id: 'c315' }, USER);
    const r = await svc.linkCobro('m2', {}, USER);
    expect(r.cobros_liberados).toEqual([
      {
        cobro_id: 'c315',
        folio: 315,
        estado: 'PARCIAL',
        faltante: 1700,
        abonos_n: 1,
      },
    ]);
    expect(r.cobros_estado).toEqual([]);
    expect(partesDe(db, 'c315')).toEqual([['m1', 1700]]);
    expect(db.movimiento_bancario[0]).toMatchObject({
      cobro_id: 'c315',
      cobros_n: 1,
      conciliado: true,
    });
    expect(db.movimiento_bancario[1]).toMatchObject({
      cobro_id: null,
      cobros_n: 0,
      conciliado: false,
    });
    const r2 = await svc.linkCobro('m1', {}, USER);
    expect(r2.cobros_liberados).toEqual([
      {
        cobro_id: 'c315',
        folio: 315,
        estado: 'SIN_CONCILIAR',
        faltante: 3400,
        abonos_n: 0,
      },
    ]);
    // Un abono sin cobros también responde la llave (vacía).
    const r3 = await svc.linkCobro('m3', {}, USER);
    expect(r3.cobros_liberados).toEqual([]);
  });

  it('desvincular un LOTE ⇒ cobros_liberados de cada cobro (leídos ANTES de soltar)', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c277', 'v277', 40999), cobro('c278', 'v278', 28001)],
      movimiento_bancario: [abono('mV', 69000)],
    });
    const { svc } = armar(db);
    await svc.linkCobro('mV', { cobro_ids: ['c277', 'c278'] }, USER);
    const r = await svc.linkCobro('mV', {}, USER);
    expect(r.cobros_liberados).toEqual([
      {
        cobro_id: 'c277',
        folio: 277,
        estado: 'SIN_CONCILIAR',
        faltante: 40999,
        abonos_n: 0,
      },
      {
        cobro_id: 'c278',
        folio: 278,
        estado: 'SIN_CONCILIAR',
        faltante: 28001,
        abonos_n: 0,
      },
    ]);
    expect(db.movimiento_bancario_cobro).toEqual([]);
  });

  it('opts.respuesta = false (auto-cruce, Paywise): la fila del UPDATE, sin releer ni cobros_estado', async () => {
    const { svc, log } = camionetas();
    const antes = log.length;
    const r = await svc.linkCobro('m1', { cobro_id: 'c315' }, USER, {
      respuesta: false,
    });
    expect(r.id).toBe('m1');
    expect(r).not.toHaveProperty('cobros_estado');
    // Ninguna lectura después del UPDATE.
    const despues = log.slice(antes);
    const iUpdate = despues.findIndex(
      (o) => o.tabla === 'movimiento_bancario' && o.op === 'update',
    );
    expect(iUpdate).toBeGreaterThanOrEqual(0);
    expect(despues.slice(iUpdate + 1)).toEqual([]);
  });
});

describe('Vincular — abono de MÁS (#315 $68,205.55 + #332 $977.45 = $69,183)', () => {
  const caso = () =>
    armar(
      mundo({
        cobro_vuelo: [
          cobro('c315', 'v315', 68205.55),
          cobro('c332', 'v332', 977.45, {
            fecha_cobro: '2026-09-14T17:00:00Z',
          }),
        ],
        movimiento_bancario: [abono('m69', 69183)],
      }),
    );

  for (const camino of ['cobro_id', 'cobro_ids'] as const) {
    it(`${camino}: 69,183 contra #315 solo ⇒ 409 ABONO_EXCEDE_COBRO con sugeridos[0] = el cobro de #332, sin escribir`, async () => {
      const { svc, db, escrituras } = caso();
      const r = await error(
        svc.linkCobro(
          'm69',
          camino === 'cobro_id'
            ? { cobro_id: 'c315' }
            : { cobro_ids: ['c315'] },
          USER,
        ),
      );
      expect(r.e).toBeInstanceOf(ConflictException);
      expect(r.code).toBe('ABONO_EXCEDE_COBRO');
      expect(r.message).toBe(
        'Este abono ($69,183.00 MXN) es mayor que lo que falta del cobro del vuelo #315 ($68,205.55 MXN): sobran $977.45 MXN. Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.',
      );
      expect(r.details).toMatchObject({
        movimiento_id: 'm69',
        cobro_id: 'c315',
        folio: 315,
        moneda: 'MXN',
        monto_cobro: 68205.55,
        neto: 68205.55,
        suma_otras: 0,
        abonos_otros: 0,
        parte: 69183,
        faltante: 68205.55,
        excedente: 977.45,
        un_solo: false,
      });
      expect(r.details?.sugeridos).toEqual([
        {
          cobro_id: 'c332',
          vuelo_id: 'v332',
          folio: 332,
          cliente: 'Beh Kay',
          fecha_cobro: '2026-09-14T17:00:00Z',
          monto: 977.45,
          moneda: 'MXN',
          faltante: 977.45,
        },
      ]);
      expect(escrituras()).toEqual([]);
      expect(db.movimiento_bancario_cobro).toEqual([]);
    });
  }

  it('los DOS cobros (lote) ⇒ partes 68,205.55 + 977.45 = el abono', async () => {
    const { svc, db } = caso();
    const r = await svc.linkCobro('m69', { cobro_ids: ['c315', 'c332'] }, USER);
    expect(partesDe(db, 'c315')).toEqual([['m69', 68205.55]]);
    expect(partesDe(db, 'c332')).toEqual([['m69', 977.45]]);
    expect(r.cobros_estado).toEqual([
      expect.objectContaining({ cobro_id: 'c315', cobro_estado: 'CONCILIADO' }),
      expect.objectContaining({ cobro_id: 'c332', cobro_estado: 'CONCILIADO' }),
    ]);
  });

  it('sugeridos best-effort: si la lectura del universo falla, el 409 sale igual con sugeridos []', async () => {
    let lecturas = 0;
    const { svc } = armar(
      mundo({
        cobro_vuelo: [
          cobro('c315', 'v315', 68205.55),
          cobro('c332', 'v332', 977.45),
        ],
        movimiento_bancario: [abono('m69', 69183)],
      }),
      {
        antes: (op) => {
          // La 1.ª lectura de cobro_vuelo es la del cobro a ligar; la del
          // universo de sugeridos (la que filtra por fecha) se cae.
          if (
            op.tabla === 'cobro_vuelo' &&
            op.op === 'select' &&
            op.sel.includes('referencia')
          ) {
            lecturas += 1;
            return {
              code: '57014',
              message: 'canceling statement due to statement timeout',
            };
          }
          return undefined;
        },
      },
    );
    const r = await error(svc.linkCobro('m69', { cobro_id: 'c315' }, USER));
    expect(r.code).toBe('ABONO_EXCEDE_COBRO');
    expect(r.details?.sugeridos).toEqual([]);
    expect(lecturas).toBe(1);
  });
});

describe('Vincular — lotes por FALTANTE (Villanueva #277 + #278)', () => {
  it('69,000 = 40,999 + 28,001 ⇒ ok; con #278 que ya tenía 10,000 ⇒ 409 ABONO_NO_CUADRA por faltante sin llamar la RPC', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c277', 'v277', 40999), cobro('c278', 'v278', 28001)],
      movimiento_bancario: [abono('mV', 69000), abono('mW', 69000)],
    });
    const { svc, log } = armar(db);
    await svc.linkCobro('mV', { cobro_ids: ['c277', 'c278'] }, USER);
    expect(partesDe(db, 'c278')).toEqual([['mV', 28001]]);
    // Otro escenario: #278 con un abono previo de 10,000.
    const db2 = mundo({
      cobro_vuelo: [cobro('c277', 'v277', 40999), cobro('c278', 'v278', 28001)],
      movimiento_bancario: [abono('mV', 69000)],
    });
    ligado(db2, 'mP', 10000, 'c278');
    const dos = armar(db2);
    const antes = dos.log.length;
    const r = await error(
      dos.svc.linkCobro('mV', { cobro_ids: ['c277', 'c278'] }, USER),
    );
    expect(r.code).toBe('ABONO_NO_CUADRA');
    expect(r.message).toBe(
      'A los 2 cobros les faltan $59,000.00 MXN (lo que le falta a cada uno) y el abono es de $69,000.00 MXN: sobran $10,000.00 MXN (se admite hasta $0.02 de diferencia por redondeos). Revisa qué cobros paga este abono o corrige el monto o la comisión de alguno.',
    );
    expect(r.details).toMatchObject({
      monto_abono: 69000,
      suma_cobros: 59000,
      diferencia: 10000,
      tolerancia: 0.02,
      moneda: 'MXN',
    });
    expect((r.details?.cobros as Row[])[1]).toMatchObject({
      id: 'c278',
      neto: 28001,
      suma_otras: 10000,
      abonos_otros: 1,
      faltante: 18001,
      parte: 18001,
    });
    expect(
      dos.log
        .slice(antes)
        .some((o) => o.tabla.startsWith('rpc:conciliacion_ligar')),
    ).toBe(false);
    expect(log.length).toBeGreaterThan(0);
  });

  it('D5: 69,000 = 50,999 + lo que le FALTA a un cobro de 30,000 con 11,999 previos (18,001) ⇒ ok y el cobro queda cubierto con 2 abonos', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c277', 'v277', 50999), cobro('c278', 'v278', 30000)],
      movimiento_bancario: [abono('mV', 69000)],
    });
    ligado(db, 'mP', 11999, 'c278');
    const { svc } = armar(db);
    const r = await svc.linkCobro('mV', { cobro_ids: ['c277', 'c278'] }, USER);
    expect(partesDe(db, 'c278')).toEqual([
      ['mP', 11999],
      ['mV', 18001],
    ]);
    expect(r.cobros_estado).toEqual([
      expect.objectContaining({ cobro_id: 'c277', cobro_estado: 'CONCILIADO' }),
      expect.objectContaining({
        cobro_id: 'c278',
        monto_parte: 18001,
        cobro_estado: 'CONCILIADO',
        cobro_abonos_n: 2,
      }),
    ]);
  });

  it('un cobro ya CUBIERTO dentro del lote ⇒ 409 COBRO_YA_CONCILIADO sin llamar la RPC', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c277', 'v277', 40999), cobro('c278', 'v278', 28001)],
      movimiento_bancario: [abono('mV', 69000)],
    });
    ligado(db, 'mP', 28001, 'c278');
    const { svc, log } = armar(db);
    const r = await error(
      svc.linkCobro('mV', { cobro_ids: ['c277', 'c278'] }, USER),
    );
    expect(r.code).toBe('COBRO_YA_CONCILIADO');
    expect(r.details).toMatchObject({
      cobro_id: 'c278',
      motivo: 'CUBIERTO',
      movimiento_id: 'mP',
    });
    expect(
      log.some((o) => o.tabla === 'rpc:conciliacion_ligar_abono_cobros'),
    ).toBe(false);
  });
});

describe('Vincular — cobros «de un solo abono»: comisión (HSBC link) y pasarela (Paywise)', () => {
  it('HSBC: 5,000 con 250 ⇒ 4,750 concilia; 4,000 ⇒ COMISION_NO_CUADRA (comisión real 1,000); 5,500 ⇒ ABONO_EXCEDE_COBRO un_solo', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('cH', 'v315', 5000, {
          comision_banco_monto: 250,
          comision_banco_pct: 5,
          metodo_cobro: 'HSBC_LINK',
        }),
      ],
      movimiento_bancario: [
        abono('a4000', 4000),
        abono('a5500', 5500),
        abono('a4750', 4750),
      ],
    });
    const { svc } = armar(db);
    const c = await error(svc.linkCobro('a4000', { cobro_id: 'cH' }, USER));
    expect(c.code).toBe('COMISION_NO_CUADRA');
    expect(c.details).toMatchObject({
      comision_capturada: 250,
      neto: 4750,
      parte: 4000,
      comision_real: 1000,
      comision_real_pct: 20,
      por: 'COMISION',
      corregible: true,
    });
    const e = await error(svc.linkCobro('a5500', { cobro_id: 'cH' }, USER));
    expect(e.code).toBe('ABONO_EXCEDE_COBRO');
    expect(e.details).toMatchObject({ un_solo: true, excedente: 750 });
    expect(e.message).toBe(
      'Este abono ($5,500.00 MXN) es mayor que el cobro del vuelo #315 ($5,000.00 MXN), que se concilia con un solo depósito: sobran $750.00 MXN sobre lo esperado. Revisa si el depósito pagó también otro vuelo o si el cobro está mal capturado.',
    );
    const ok = await svc.linkCobro('a4750', { cobro_id: 'cH' }, USER);
    expect(ok.cobros_estado).toEqual([
      expect.objectContaining({ cobro_estado: 'CONCILIADO', cobro_neto: 4750 }),
    ]);
    expect(db.movimiento_bancario_cobro).toHaveLength(1);
  });

  it('Paywise #293 (13,000 − 1,129.76): 11,800 ⇒ COMISION_NO_CUADRA por PASARELA con el texto de la comisión real', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c293', 'v293', 13000, {
          comision_banco_monto: 1129.76,
          comision_banco_pct: 8.6905,
          metodo_cobro: 'PAYWISE',
        }),
      ],
      movimiento_bancario: [
        abono('mPw', 11800, { cuenta_bancaria_id: CTA_PW }),
      ],
    });
    const { svc, escrituras } = armar(db);
    const r = await error(svc.linkCobro('mPw', { cobro_id: 'c293' }, USER));
    expect(r.code).toBe('COMISION_NO_CUADRA');
    expect(r.message).toBe(
      'El cobro del vuelo #293 ($13,000.00 MXN) espera un depósito de $11,870.24 MXN después de la comisión registrada ($1,129.76) y el banco depositó $11,800.00 MXN: la comisión real fue $1,200.00 MXN (9.23 %). Corrige la comisión del cobro o usa «Corregir la comisión a $1,200.00 y vincular».',
    );
    expect(r.details).toMatchObject({
      por: 'PASARELA',
      comision_real: 1200,
      comision_real_pct: 9.23,
      corregible: true,
    });
    expect(escrituras()).toEqual([]);
  });

  it('corregir_comision: escribe la comisión real (1,200 · 9.2308 %) con la escritura ÚNICA y liga; responde comision_corregida', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c293', 'v293', 13000, {
          comision_banco_monto: 1129.76,
          comision_banco_pct: 8.6905,
          metodo_cobro: 'PAYWISE',
        }),
      ],
      movimiento_bancario: [
        abono('mPw', 11800, { cuenta_bancaria_id: CTA_PW }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.linkCobro(
      'mPw',
      { cobro_id: 'c293', corregir_comision: true },
      USER,
    );
    expect(db.cobro_vuelo[0]).toMatchObject({
      comision_banco_monto: 1200,
      comision_banco_pct: 9.2308,
      updated_by: USER,
    });
    expect(partesDe(db, 'c293')).toEqual([['mPw', 11800]]);
    expect(r.comision_corregida).toEqual({
      cobro_id: 'c293',
      antes: 1129.76,
      despues: 1200,
    });
    expect(r.cobros_estado).toEqual([
      expect.objectContaining({
        cobro_estado: 'CONCILIADO',
        cobro_neto: 11800,
      }),
    ]);
  });

  it('los 3 Paywise pendientes de prod (33,303.64 · 21,223.10 · 7,848.89) contra cobros sin comisión ⇒ COMISION_NO_CUADRA y, con corregir_comision por cobro_ids, se escribe y liga', async () => {
    const montos: Array<[string, number, number]> = [
      ['p1', 33303.64, 36500],
      ['p2', 21223.1, 23260],
      ['p3', 7848.89, 8600],
    ];
    const db = mundo({
      cobro_vuelo: montos.map(([id, , monto]) =>
        cobro(`c-${id}`, 'v293', monto, { metodo_cobro: 'PAYWISE' }),
      ),
      movimiento_bancario: montos.map(([id, m]) =>
        abono(id, m, { cuenta_bancaria_id: CTA_PW }),
      ),
    });
    const { svc } = armar(db);
    for (const [id, m, monto] of montos) {
      const r = await error(svc.linkCobro(id, { cobro_id: `c-${id}` }, USER));
      expect([id, r.code, r.details?.comision_real]).toEqual([
        id,
        'COMISION_NO_CUADRA',
        Math.round((monto - m) * 100) / 100,
      ]);
      const ok = await svc.linkCobro(
        id,
        { cobro_ids: [`c-${id}`], corregir_comision: true },
        USER,
      );
      expect(ok.comision_corregida).toEqual({
        cobro_id: `c-${id}`,
        antes: null,
        despues: Math.round((monto - m) * 100) / 100,
      });
    }
    expect(db.movimiento_bancario_cobro).toHaveLength(3);
  });

  it('un parcial de BANCO no admite un abono de la PASARELA ⇒ 409 COBRO_YA_CONCILIADO (UN_SOLO_ABONO, por PASARELA)', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400)],
      movimiento_bancario: [abono('mPw', 1700, { cuenta_bancaria_id: CTA_PW })],
    });
    ligado(db, 'm1', 1700, 'c315');
    const { svc } = armar(db);
    const r = await error(svc.linkCobro('mPw', { cobro_id: 'c315' }, USER));
    expect(r.code).toBe('COBRO_YA_CONCILIADO');
    expect(r.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      por: 'PASARELA',
    });
    expect(r.message).toContain('se pagó por la pasarela (Paywise)');
  });
});

describe('corregir_comision — cuándo NO aplica (400 CORREGIR_COMISION_NO_APLICA) y el error después de corregir', () => {
  const base = () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('cH', 'v315', 5000, {
          comision_banco_monto: 250,
          comision_banco_pct: 5,
        }),
        cobro('c315', 'v315', 3400),
        cobro('c400', 'v400', 1000, { moneda: 'USD' }),
      ],
      cobro_grupo: [
        {
          id: 's12',
          grupo_id: 'g12',
          monto: 11500,
          moneda: 'MXN',
          metodo_cobro: 'TRANSFERENCIA',
          fecha_cobro: '2026-09-15T17:00:00Z',
          referencia: null,
          comision_banco_monto: 699.24,
        },
      ],
      movimiento_bancario: [
        abono('a1', 1000),
        abono('a2', 5000.5),
        abono('a3', 17000),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    return armar(db);
  };

  it.each([
    [
      'dos cobros',
      { cobro_ids: ['cH', 'c315'], corregir_comision: true },
      'VARIOS_COBROS',
    ],
    ['un sobre', { cobro_grupo_id: 's12', corregir_comision: true }, 'SOBRE'],
    ['sin cobro', { corregir_comision: true }, 'SIN_COBRO'],
    [
      'cobro con abonos',
      { cobro_id: 'c315', corregir_comision: true },
      'CON_ABONOS',
    ],
  ])('%s ⇒ 400 sin escribir', async (_n, liga, motivo) => {
    const { svc, db, escrituras } = base();
    const r = await error(svc.linkCobro('a1', liga, USER));
    expect(r.e).toBeInstanceOf(BadRequestException);
    expect(r.code).toBe('CORREGIR_COMISION_NO_APLICA');
    expect(r.details).toEqual({ motivo });
    expect(r.message).toBe(
      'La comisión solo se corrige al vincular UN cobro de vuelo que todavía no tiene abonos, cuando el depósito es menor o igual que el cobro.',
    );
    expect(escrituras()).toEqual([]);
    expect(db.cobro_vuelo[0].comision_banco_monto).toBe(250);
  });

  it('depósito MAYOR que el cobro ⇒ 400 DEPOSITO_MAYOR; sin corregir, COMISION_NO_CUADRA no ofrece la corrección', async () => {
    const { svc, escrituras } = base();
    const r = await error(
      svc.linkCobro('a2', { cobro_id: 'cH', corregir_comision: true }, USER),
    );
    expect(r.code).toBe('CORREGIR_COMISION_NO_APLICA');
    expect(r.details).toEqual({ motivo: 'DEPOSITO_MAYOR' });
    const sin = await error(svc.linkCobro('a2', { cobro_id: 'cH' }, USER));
    expect(sin.code).toBe('COMISION_NO_CUADRA');
    expect(sin.details).toMatchObject({ corregible: false, comision_real: 0 });
    expect(sin.message).toBe(
      'El cobro del vuelo #315 ($5,000.00 MXN) espera un depósito de $4,750.00 MXN después de la comisión registrada ($250.00) y el banco depositó $5,000.50 MXN, más que el cobro: revisa la comisión registrada (el cliente pudo pagarla aparte) y corrígela en el vuelo antes de vincular.',
    );
    expect(escrituras()).toEqual([]);
  });

  for (const camino of ['cobro_id', 'cobro_ids'] as const) {
    const liga = (id: string) =>
      camino === 'cobro_id'
        ? { cobro_id: id, corregir_comision: true }
        : { cobro_ids: [id], corregir_comision: true };

    it(`${camino}: la PARTE de un sobre ⇒ 409 COBRO_DE_GRUPO SIN escribir la comisión (revisión del 15-oct-2026: por cobro_ids se escribía antes del rechazo)`, async () => {
      const db = mundo({
        cobro_grupo: [
          {
            id: 's12',
            grupo_id: 'g12',
            monto: 11500,
            moneda: 'MXN',
            metodo_cobro: 'TRANSFERENCIA',
            fecha_cobro: '2026-09-15T17:00:00Z',
            referencia: null,
            comision_banco_monto: 699.24,
          },
        ],
        cobro_vuelo: [
          cobro('cParte', 'v315', 5750, {
            comision_banco_monto: 349.62,
            comision_banco_pct: 6.0803,
            cobro_grupo_id: 's12',
          }),
        ],
        movimiento_bancario: [abono('a1', 4000)],
      });
      const { svc, escrituras } = armar(db);
      const r = await error(svc.linkCobro('a1', liga('cParte'), USER));
      expect(r.e).toBeInstanceOf(ConflictException);
      expect(r.code).toBe('COBRO_DE_GRUPO');
      expect(r.details).not.toHaveProperty('comision_corregida');
      expect(r.message).not.toContain('ya quedó corregida');
      expect(db.cobro_vuelo[0]).toMatchObject({
        comision_banco_monto: 349.62,
        comision_banco_pct: 6.0803,
      });
      expect(db.movimiento_bancario_cobro).toEqual([]);
      expect(escrituras()).toEqual([]);
    });

    it(`${camino}: banco SIN comisión y depósito menor ⇒ 400 PARCIAL sin escribir (es un pago en partes, no una comisión); sin la bandera liga PARCIAL`, async () => {
      const db = mundo({
        cobro_vuelo: [cobro('c315', 'v315', 3400)],
        movimiento_bancario: [abono('m1', 1700)],
      });
      const { svc, escrituras } = armar(db);
      const r = await error(svc.linkCobro('m1', liga('c315'), USER));
      expect(r.e).toBeInstanceOf(BadRequestException);
      expect(r.code).toBe('CORREGIR_COMISION_NO_APLICA');
      expect(r.details).toEqual({ motivo: 'PARCIAL' });
      expect(r.message).toContain('un depósito menor es un pago parcial');
      expect(escrituras()).toEqual([]);
      expect(db.cobro_vuelo[0].comision_banco_monto).toBeNull();
      const ok = await svc.linkCobro(
        'm1',
        camino === 'cobro_id' ? { cobro_id: 'c315' } : { cobro_ids: ['c315'] },
        USER,
      );
      expect(ok.cobros_estado).toEqual([
        expect.objectContaining({ cobro_estado: 'PARCIAL' }),
      ]);
      expect(db.cobro_vuelo[0].comision_banco_monto).toBeNull();
    });

    it(`${camino}: el depósito ya cuadra con la comisión capturada ⇒ 400 NO_HACE_FALTA sin escribir`, async () => {
      const db = mundo({
        cobro_vuelo: [
          cobro('cH', 'v315', 5000, {
            comision_banco_monto: 250,
            comision_banco_pct: 5,
          }),
        ],
        movimiento_bancario: [abono('a4750', 4750.5)],
      });
      const { svc, escrituras } = armar(db);
      const r = await error(svc.linkCobro('a4750', liga('cH'), USER));
      expect(r.code).toBe('CORREGIR_COMISION_NO_APLICA');
      expect(r.details).toEqual({ motivo: 'NO_HACE_FALTA' });
      expect(escrituras()).toEqual([]);
      expect(db.cobro_vuelo[0].comision_banco_monto).toBe(250);
    });
  }

  it('cobro en OTRA moneda ⇒ 400 MONEDA_DISTINTA', async () => {
    const { svc } = base();
    const r = await error(
      svc.linkCobro('a3', { cobro_id: 'c400', corregir_comision: true }, USER),
    );
    expect(r.code).toBe('CORREGIR_COMISION_NO_APLICA');
    expect(r.details).toEqual({ motivo: 'MONEDA_DISTINTA' });
  });

  it('la liga falla DESPUÉS de corregir (otra sesión ligó otro abono): la comisión QUEDA y el 409 lo dice', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c293', 'v293', 13000, {
          comision_banco_monto: 1129.76,
          comision_banco_pct: 8.6905,
          metodo_cobro: 'PAYWISE',
        }),
      ],
      movimiento_bancario: [
        abono('mPw', 11800, { cuenta_bancaria_id: CTA_PW }),
        abono('mOtro', 5000, {
          cuenta_bancaria_id: CTA_PW,
          fecha: '2026-09-14',
        }),
      ],
    });
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (
          !carrera &&
          op.tabla === 'movimiento_bancario' &&
          op.op === 'update'
        ) {
          carrera = true;
          const otro = tablas.movimiento_bancario.find(
            (m) => m.id === 'mOtro',
          )!;
          Object.assign(otro, {
            cobro_id: 'c293',
            cobros_n: 1,
            conciliado: true,
          });
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mOtro',
            cobro_id: 'c293',
            monto_parte: 5000,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(
      svc.linkCobro('mPw', { cobro_id: 'c293', corregir_comision: true }, USER),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('COBRO_YA_CONCILIADO');
    expect(r.message).toContain('se pagó por la pasarela (Paywise)');
    expect(r.message).toContain(
      'La comisión del cobro ya quedó corregida a $1,200.00 (antes $1,129.76).',
    );
    expect(r.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      comision_corregida: { cobro_id: 'c293', antes: 1129.76, despues: 1200 },
    });
    expect(db.cobro_vuelo[0].comision_banco_monto).toBe(1200);
    expect(partesDe(db, 'c293')).toEqual([['mOtro', 5000]]);
  });
});

describe('Vincular — otra moneda (1↔1, banda 15–25 y ±2 % del T.C.) y sobres (SOBRE_NO_CUADRA)', () => {
  it('cobro USD 1,000 (vuelo a 17.00): 20,400 MXN ⇒ TC_LEJOS; 500 ⇒ TC_FUERA_DE_BANDA; 17,000 ⇒ concilia (cruzado = cubierto)', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c400', 'v400', 1000, { moneda: 'USD' })],
      movimiento_bancario: [
        abono('x1', 20400),
        abono('x2', 500),
        abono('x3', 17000),
      ],
    });
    const { svc } = armar(db);
    const lejos = await error(svc.linkCobro('x1', { cobro_id: 'c400' }, USER));
    expect(lejos.code).toBe('COBRO_MONEDA_DISTINTA');
    expect(lejos.details).toMatchObject({
      motivo: 'TC_LEJOS',
      tc_implicito: 20.4,
      tc_referencia: 17,
      desvio_pct: 20,
      tc_referencia_origen: 'VUELO',
      moneda_cobro: 'USD',
      moneda_cuenta: 'MXN',
      tc_min: 15,
      tc_max: 25,
    });
    expect(lejos.message).toBe(
      'El abono de $20,400.00 MXN contra el cobro de $1,000.00 USD del vuelo #400 da un tipo de cambio de 20.40, lejos del T.C. del vuelo (17.00, +20.0 %): ¿el depósito pagó también otro cobro? Un abono en otra moneda solo concilia UN cobro completo; si así llegó el dinero, registra el cobro en la moneda del depósito.',
    );
    const banda = await error(svc.linkCobro('x2', { cobro_id: 'c400' }, USER));
    expect(banda.details).toMatchObject({
      motivo: 'TC_FUERA_DE_BANDA',
      tc_implicito: 0.5,
    });
    expect(banda.message).toBe(
      'El cobro del vuelo #400 está en USD y el abono en MXN: el tipo de cambio que resulta (0.50) no tiene sentido (se espera entre 15 y 25). Revisa que sea el abono correcto.',
    );
    const ok = await svc.linkCobro('x3', { cobro_id: 'c400' }, USER);
    expect(ok.cobros_estado).toEqual([
      expect.objectContaining({
        cobro_estado: 'CONCILIADO',
        cobro_faltante: 0,
      }),
    ]);
  });

  it('sobre G-12 (11,500 − 699.24 = 10,800.76): 10,000 de banco ⇒ 409 SOBRE_NO_CUADRA sin escribir; el neto exacto o la pasarela ⇒ liga', async () => {
    const sobre = {
      id: 's12',
      grupo_id: 'g12',
      monto: 11500,
      moneda: 'MXN',
      metodo_cobro: 'TRANSFERENCIA',
      fecha_cobro: '2026-09-15T17:00:00Z',
      referencia: null,
      comision_banco_monto: 699.24,
    };
    const db = mundo({
      cobro_grupo: [sobre],
      movimiento_bancario: [abono('s1', 10000), abono('s2', 10800.76)],
    });
    const { svc, escrituras } = armar(db);
    const r = await error(svc.linkCobro('s1', { cobro_grupo_id: 's12' }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('SOBRE_NO_CUADRA');
    expect(r.message).toBe(
      'El abono ($10,000.00 MXN) no cuadra con el sobre del grupo G-12 ($10,800.76 MXN después de la comisión): faltan $800.76 MXN. Revisa que sea el depósito del grupo o corrige el sobre antes de vincular.',
    );
    expect(r.details).toEqual({
      movimiento_id: 's1',
      cobro_grupo_id: 's12',
      grupo_folio: 12,
      monto_abono: 10000,
      neto_sobre: 10800.76,
      diferencia: -800.76,
      moneda: 'MXN',
    });
    expect(escrituras()).toEqual([]);
    await svc.linkCobro('s2', { cobro_grupo_id: 's12' }, USER);
    expect(db.movimiento_bancario[1]).toMatchObject({
      cobro_grupo_id: 's12',
      conciliado: true,
    });
    // Pasarela: como siempre (sin la regla del neto).
    const db2 = mundo({
      cobro_grupo: [{ ...sobre }],
      movimiento_bancario: [abono('s3', 10000, { cuenta_bancaria_id: CTA_PW })],
    });
    const pw = armar(db2);
    await pw.svc.linkCobro('s3', { cobro_grupo_id: 's12' }, USER);
    expect(db2.movimiento_bancario[0].cobro_grupo_id).toBe('s12');
  });

  it('un CARGO no paga un cobro ⇒ 400 SOLO_ABONOS sin escribir; omitido ⇒ 409 MOVIMIENTO_OMITIDO (lote B intacto)', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400)],
      conciliacion_clasificacion: [
        { id: 'cl-omit', nombre: 'Omitido de la conciliación', activa: true },
      ],
      movimiento_bancario: [
        abono('k1', -1700, { tipo: 'CARGO' }),
        abono('o1', 1700, {
          clasificacion_id: 'cl-omit',
          conciliado: true,
          notas:
            'Omitido de la conciliación: prueba de la terminal — Mary Cruz, 14-oct-2026',
        }),
      ],
    });
    const { svc, escrituras } = armar(db);
    const cargo = await error(svc.linkCobro('k1', { cobro_id: 'c315' }, USER));
    expect(cargo.e).toBeInstanceOf(BadRequestException);
    expect(cargo.code).toBe('SOLO_ABONOS');
    const omitido = await error(
      svc.linkCobro('o1', { cobro_id: 'c315' }, USER),
    );
    expect(omitido.code).toBe('MOVIMIENTO_OMITIDO');
    expect(escrituras()).toEqual([]);
  });
});

describe('candidatos-cobro — al_vincular, sugeridos y capacidades (D18)', () => {
  it('cada candidato trae al_vincular del abono: CONCILIADO (completa un parcial), PARCIAL, EXCEDE con sugeridos, COMISION_NO_CUADRA; sobres CONCILIADO | SOBRE_NO_CUADRA', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400),
        cobro('c316', 'v332', 5000),
        cobro('c317', 'v277', 1500),
        cobro('c318', 'v278', 200),
        cobro('cH', 'v293', 2000, { comision_banco_monto: 100 }),
      ],
      cobro_grupo: [
        {
          id: 's12',
          grupo_id: 'g12',
          monto: 2000,
          moneda: 'MXN',
          metodo_cobro: 'TRANSFERENCIA',
          fecha_cobro: '2026-09-15T17:00:00Z',
          referencia: null,
          comision_banco_monto: null,
        },
        {
          id: 's13',
          grupo_id: 'g12',
          monto: 1700,
          moneda: 'MXN',
          metodo_cobro: 'TRANSFERENCIA',
          fecha_cobro: '2026-09-15T17:00:00Z',
          referencia: null,
          comision_banco_monto: null,
        },
      ],
      movimiento_bancario: [abono('m2', 1700, { fecha: '2026-09-16' })],
    });
    ligado(db, 'm1', 1700, 'c315');
    const { svc } = armar(db);
    const r = await svc.candidatosCobro('m2', 60);
    const al = (id: string) =>
      (r.candidatos.find((c) => c.id === id) as { al_vincular?: Row })
        .al_vincular;
    expect(al('c315')).toMatchObject({
      estado: 'CONCILIADO',
      faltante_antes: 1700,
      faltante_despues: 0,
    });
    expect(al('c316')).toMatchObject({
      estado: 'PARCIAL',
      faltante_despues: 3300,
    });
    expect(al('c317')).toMatchObject({
      estado: 'EXCEDE',
      sobrante: 200,
      sugeridos: [expect.objectContaining({ cobro_id: 'c318', faltante: 200 })],
    });
    expect(al('cH')).toMatchObject({
      estado: 'COMISION_NO_CUADRA',
      comision_real: 300,
    });
    expect(al('s12')).toEqual({ estado: 'SOBRE_NO_CUADRA', diferencia: -300 });
    expect(al('s13')).toEqual({ estado: 'CONCILIADO', diferencia: 0 });
    expect(r.movimiento).toMatchObject({
      cobros_parciales: true,
      corregir_comision: true,
      tipo_cuenta: 'BANCO',
    });
  });

  it('un sugerido que no entró en los 60 candidatos va AL FINAL (sin repetirse)', async () => {
    const relleno = Array.from({ length: 59 }, (_, i) =>
      cobro(`f${String(i).padStart(2, '0')}`, 'v278', 69183.5 + i * 0.01),
    );
    const db = mundo({
      cobro_vuelo: [
        ...relleno,
        cobro('c315', 'v315', 68205.55),
        cobro('c332', 'v332', 977.45),
      ],
      movimiento_bancario: [abono('m69', 69183)],
    });
    const { svc } = armar(db);
    const r = await svc.candidatosCobro('m69', 60);
    const ids = r.candidatos.map((c) => c.id);
    expect(ids).toHaveLength(61);
    expect(ids[59]).toBe('c315');
    expect(ids[60]).toBe('c332');
    expect(new Set(ids).size).toBe(61);
    const c315 = r.candidatos[59] as { al_vincular?: Row };
    expect(c315.al_vincular).toMatchObject({
      estado: 'EXCEDE',
      sobrante: 977.45,
      sugeridos: [expect.objectContaining({ cobro_id: 'c332' })],
    });
  });

  it('SIN la migración: cobros_parciales false y un cobro con otro abono no es candidato', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400), cobro('c316', 'v332', 1700)],
      movimiento_bancario: [abono('m2', 1700, { fecha: '2026-09-16' })],
    });
    ligado(db, 'm1', 1700, 'c315');
    const { svc } = armar(db, { bdVieja: true });
    const r = await svc.candidatosCobro('m2', 60);
    expect(r.candidatos.map((c) => c.id)).toEqual(['c316']);
    expect(r.movimiento).toMatchObject({
      cobros_parciales: false,
      corregir_comision: true,
    });
  });
});

describe('SIN la migración 20261014000003 (BD vieja: índice único por cobro)', () => {
  const vieja = () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400),
        cobro('c316', 'v332', 1000),
        cobro('c317', 'v277', 2000),
        cobro('c318', 'v278', 1000),
      ],
      movimiento_bancario: [
        abono('m2', 1700, { fecha: '2026-09-16' }),
        abono('m4', 500),
        abono('m5', 1000),
        abono('m6', 3000),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    ligado(db, 'm3', 1000, 'c316');
    return armar(db, { bdVieja: true });
  };

  for (const camino of ['cobro_id', 'cobro_ids'] as const) {
    it(`${camino}: el 2.º abono de un PARCIAL ⇒ 503 CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE sin escribir`, async () => {
      const { svc, escrituras, db } = vieja();
      const r = await error(
        svc.linkCobro(
          'm2',
          camino === 'cobro_id'
            ? { cobro_id: 'c315' }
            : { cobro_ids: ['c315'] },
          USER,
        ),
      );
      expect(r.e).toBeInstanceOf(ServiceUnavailableException);
      expect(r.code).toBe('CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE');
      expect(r.details).toEqual({ migracion: '20261014000003' });
      expect(escrituras()).toEqual([]);
      expect(partesDe(db, 'c315')).toEqual([['m1', 1700]]);
    });
  }

  it('a uno CUBIERTO ⇒ 409 COBRO_YA_CONCILIADO; la pre-validación (EXCEDE) igual; el PRIMER abono parcial sí se liga', async () => {
    const { svc, db } = vieja();
    const cubierto = await error(
      svc.linkCobro('m4', { cobro_id: 'c316' }, USER),
    );
    expect(cubierto.code).toBe('COBRO_YA_CONCILIADO');
    expect(cubierto.details).toMatchObject({ motivo: 'CUBIERTO' });
    const excede = await error(svc.linkCobro('m6', { cobro_id: 'c318' }, USER));
    expect(excede.code).toBe('ABONO_EXCEDE_COBRO');
    await svc.linkCobro('m5', { cobro_id: 'c317' }, USER);
    expect(partesDe(db, 'c317')).toEqual([['m5', 1000]]);
  });

  it('carrera contra el índice único de la BD vieja ⇒ 409 legible y NADA escrito', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c317', 'v277', 2000)],
      movimiento_bancario: [abono('m5', 1000), abono('mX', 1000)],
    });
    let carrera = false;
    const { svc } = armar(db, {
      bdVieja: true,
      antes: (op, tablas) => {
        if (
          !carrera &&
          op.tabla === 'movimiento_bancario' &&
          op.op === 'update'
        ) {
          carrera = true;
          Object.assign(tablas.movimiento_bancario[1], {
            cobro_id: 'c317',
            cobros_n: 1,
            conciliado: true,
          });
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c317',
            monto_parte: 1000,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(svc.linkCobro('m5', { cobro_id: 'c317' }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.message).toBe(
      'Ese cobro ya está vinculado a otro movimiento bancario.',
    );
    expect(partesDe(db, 'c317')).toEqual([['mX', 1000]]);
    expect(db.movimiento_bancario[0]).toMatchObject({
      cobro_id: null,
      conciliado: false,
    });
  });
});

describe('El error REAL de la BD (carrera) llega como 409 es-MX sin « [ABONO_NO_CUADRA]»', () => {
  it('otra sesión ligó un abono al mismo cobro entre la pre-validación y el UPDATE ⇒ ABONO_EXCEDE_COBRO del trigger A con sugeridos', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400)],
      movimiento_bancario: [
        abono('m2', 1700, { fecha: '2026-09-16' }),
        abono('mX', 1000, { fecha: '2026-09-15' }),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (
          !carrera &&
          op.tabla === 'movimiento_bancario' &&
          op.op === 'update'
        ) {
          carrera = true;
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c315',
            monto_parte: 1000,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(svc.linkCobro('m2', { cobro_id: 'c315' }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('ABONO_EXCEDE_COBRO');
    expect(r.message).not.toContain('[ABONO_NO_CUADRA]');
    expect(r.message).toBe(
      'Al cobro del vuelo #315 ($3,400.00 MXN) ya le vincularon $2,700.00 MXN y le faltan $700.00 MXN; este abono es de $1,700.00 MXN: sobran $1,000.00 MXN. Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.',
    );
    expect(r.details).toMatchObject({
      excedente: 1000,
      suma_otras: 2700,
      abonos_otros: 2,
      sugeridos: [],
    });
    expect(partesDe(db, 'c315')).toEqual([
      ['m1', 1700],
      ['mX', 1000],
    ]);
  });
});

describe('Carreras por la RPC y contra el trigger E (la BD es el candado real)', () => {
  it('cobro_ids: otra sesión ligó un abono justo antes de la RPC ⇒ el ABONO_EXCEDE_COBRO de la BD (por A) sale como 409 es-MX con sugeridos', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('c315', 'v315', 3400)],
      movimiento_bancario: [
        abono('m2', 1700, { fecha: '2026-09-16' }),
        abono('mX', 1000),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (!carrera && op.tabla === 'rpc:conciliacion_ligar_abono_cobros') {
          carrera = true;
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mX',
            cobro_id: 'c315',
            monto_parte: 1000,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(svc.linkCobro('m2', { cobro_ids: ['c315'] }, USER));
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('ABONO_EXCEDE_COBRO');
    expect(r.message).not.toContain('[ABONO_NO_CUADRA]');
    expect(r.message).toContain('ya le vincularon $2,700.00 MXN');
    expect(r.details).toMatchObject({ excedente: 1000, sugeridos: [] });
    expect(partesDe(db, 'c315')).toEqual([
      ['m1', 1700],
      ['mX', 1000],
    ]);
  });

  it('corregir_comision: si otra sesión ligó un abono ANTES de escribir la comisión, el trigger E la rechaza ⇒ 409 COBRO_CONCILIADO y nada cambia', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c293', 'v293', 13000, {
          comision_banco_monto: 1129.76,
          comision_banco_pct: 8.6905,
          metodo_cobro: 'PAYWISE',
        }),
      ],
      movimiento_bancario: [
        abono('mPw', 11800, { cuenta_bancaria_id: CTA_PW }),
        abono('mOtro', 11870.24, { cuenta_bancaria_id: CTA_PW }),
      ],
    });
    let carrera = false;
    const { svc } = armar(db, {
      antes: (op, tablas) => {
        if (!carrera && op.tabla === 'cobro_vuelo' && op.op === 'update') {
          carrera = true;
          tablas.movimiento_bancario_cobro.push({
            movimiento_id: 'mOtro',
            cobro_id: 'c293',
            monto_parte: 11870.24,
            created_at: '2026-10-14T10:00:00Z',
            created_by: null,
          });
        }
        return undefined;
      },
    });
    const r = await error(
      svc.linkCobro('mPw', { cobro_id: 'c293', corregir_comision: true }, USER),
    );
    expect(r.e).toBeInstanceOf(ConflictException);
    expect(r.code).toBe('COBRO_CONCILIADO');
    expect(r.message).toBe(
      'El cobro tiene abonos del banco vinculados: su monto, moneda, comisión, sobre o anticipo no cambian mientras esté conciliado; desvincúlalo en Conciliación primero.',
    );
    expect(r.details).toMatchObject({
      cobro_id: 'c293',
      abonos: 1,
      campos: ['comision_banco_monto'],
    });
    expect(db.cobro_vuelo[0].comision_banco_monto).toBe(1129.76);
    expect(partesDe(db, 'c293')).toEqual([['mOtro', 11870.24]]);
  });
});

describe('Paywise — comisión real inferida por BRUTO antes de ligar y lotes fuera de la auditoría (D6)', () => {
  it('abono = BRUTO de un cobro con comisión provisionada (archivo sin bruto ni comisión) ⇒ escribe comisión null y liga (antes rebotaría COMISION_NO_CUADRA)', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('cB', 'v293', 7000, {
          metodo_cobro: 'PAYWISE',
          comision_banco_monto: 620,
          comision_banco_pct: 8.8571,
        }),
      ],
      movimiento_bancario: [abono('mB', 7000, { cuenta_bancaria_id: CTA_PW })],
    });
    const { svc } = armar(db);
    const r = await svc.conciliarPaywise(
      { desde: '2026-09-01', hasta: '2026-09-30', dias: 5 },
      USER,
    );
    expect(r.resumen).toMatchObject({ conciliados_ahora: 1, errores: 0 });
    expect(db.cobro_vuelo[0]).toMatchObject({
      comision_banco_monto: null,
      comision_banco_pct: null,
    });
    expect(partesDe(db, 'cB')).toEqual([['mB', 7000]]);
  });

  it('NETO exacto con un bruto del archivo DISTINTO del cobro (revisión del 15-oct-2026): NO escribe la comisión del archivo y liga con la vigente; la diferencia queda en la auditoría', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('cN', 'v293', 7000, {
          metodo_cobro: 'PAYWISE',
          comision_banco_monto: 620,
          comision_banco_pct: 8.8571,
        }),
      ],
      movimiento_bancario: [
        abono('mN', 6380, { cuenta_bancaria_id: CTA_PW, monto_bruto: 7100 }),
      ],
    });
    const { svc, escrituras } = armar(db);
    const r = await svc.conciliarPaywise(
      { desde: '2026-09-01', hasta: '2026-09-30', dias: 5 },
      USER,
    );
    expect(r.resumen).toMatchObject({ conciliados_ahora: 1, errores: 0 });
    // La comisión del cobro NO cambió (antes: 720 escrita y la liga rebotaba).
    expect(db.cobro_vuelo[0]).toMatchObject({
      comision_banco_monto: 620,
      comision_banco_pct: 8.8571,
    });
    expect(escrituras().some((e) => e.tabla === 'cobro_vuelo')).toBe(false);
    expect(partesDe(db, 'cN')).toEqual([['mN', 6380]]);
    // La auditoría releída lo reporta YA ligado con la comisión distinta.
    expect(
      r.comision_distinta.map((c) => [c.criterio, c.comision_paywise]),
    ).toEqual([['YA_CONCILIADO', 720]]);
    expect(r.solo_paywise).toEqual([]);
    expect(r.solo_sistema).toEqual([]);
  });

  it('el cliente pagó la comisión ENCIMA (cobro 7,000 sin comisión, depósito 7,000, bruto del archivo 7,406): «Conciliar lo que cuadra» liga sin escribir los 406', async () => {
    const db = mundo({
      cobro_vuelo: [cobro('cF', 'v293', 7000, { metodo_cobro: 'PAYWISE' })],
      movimiento_bancario: [
        abono('mF', 7000, { cuenta_bancaria_id: CTA_PW, monto_bruto: 7406 }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.conciliarPaywise(
      { desde: '2026-09-01', hasta: '2026-09-30', dias: 5 },
      USER,
    );
    expect(r.resumen).toMatchObject({ conciliados_ahora: 1, errores: 0 });
    expect(db.cobro_vuelo[0]).toMatchObject({
      comision_banco_monto: null,
      comision_banco_pct: null,
    });
    expect(partesDe(db, 'cF')).toEqual([['mF', 7000]]);
  });

  it('un abono de la pasarela que paga 2+ cobros (lote) no es «libre»: fuera del cruce y contado en movimientos_en_lote', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('cA', 'v293', 3000, { metodo_cobro: 'PAYWISE' }),
        cobro('cC', 'v315', 4000, { metodo_cobro: 'PAYWISE' }),
      ],
      movimiento_bancario: [
        abono('mL', 7000, {
          cuenta_bancaria_id: CTA_PW,
          conciliado: true,
          cobros_n: 2,
        }),
      ],
      movimiento_bancario_cobro: [
        {
          movimiento_id: 'mL',
          cobro_id: 'cA',
          monto_parte: 3000,
          created_at: '2026-10-13T16:00:00Z',
          created_by: null,
        },
        {
          movimiento_id: 'mL',
          cobro_id: 'cC',
          monto_parte: 4000,
          created_at: '2026-10-13T16:00:00Z',
          created_by: null,
        },
      ],
    });
    const { svc } = armar(db);
    const r = await svc.auditoriaPaywise({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      dias: 5,
    });
    expect(r.resumen).toMatchObject({
      movimientos_paywise: 0,
      movimientos_en_lote: 1,
    });
  });
});
