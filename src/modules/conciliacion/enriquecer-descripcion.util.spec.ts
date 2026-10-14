import { emparejarDuplicados } from './auto-cruce.util';
import {
  descripcionParaGuardar,
  direccionDeFechas,
  esFilaVirgen,
  esLeyendaSinConcepto,
  esPreviaElegible,
  estadoCuentaIdsParaDireccion,
  extiendeLeyenda,
  idsParaLeerFolios,
  LEYENDAS_SIN_CONCEPTO,
  lineasNuevasEnBucketConocido,
  planEnriquecimiento,
  type ContextoEnriquecimiento,
  type FilaPreviaEnriquecible,
  type LineaNuevaEnriquecedora,
} from './enriquecer-descripcion.util';
import type { NumeroFactura } from './factura-concepto.util';

/**
 * CONCEPTO DEL SPEI AL RE-SUBIR (13-oct-2026, API 0.0.75, invariante 69).
 * Todos los escenarios corren sobre el `emparejarDuplicados` REAL: el plan
 * nunca adivina (lo ambiguo sale como GEMELOS) y jamás devuelve montos,
 * fechas ni ligas.
 */
const R = '00000000000000000001';
const SPEI = 'SEL TRANSF. INTERBANCARIA SPEI';

let orden = 0;
const P = (
  id: string,
  fecha: string,
  monto: string | number,
  descripcion: string,
  extra: Partial<FilaPreviaEnriquecible> & { ref?: string } = {},
): FilaPreviaEnriquecible => {
  const { ref, ...resto } = extra;
  return {
    id,
    fecha,
    tipo: 'CARGO',
    monto,
    descripcion,
    referencia: ref ?? R,
    origen: 'IMPORTADO',
    conciliado: false,
    notas: '',
    ...resto,
  };
};
const N = (
  fecha: string,
  monto: string | number,
  descripcion: string,
  extra: { tipo?: string; ref?: string; orden?: number } = {},
): LineaNuevaEnriquecedora => ({
  fecha,
  tipo: extra.tipo ?? 'CARGO',
  monto,
  descripcion,
  referencia: extra.ref ?? R,
  orden_archivo: extra.orden ?? ++orden,
});

function correr(
  nuevos: LineaNuevaEnriquecedora[],
  previos: FilaPreviaEnriquecible[],
  ctx: ContextoEnriquecimiento = {},
) {
  const e = emparejarDuplicados(nuevos, previos);
  const plan = planEnriquecimiento(nuevos, previos, e.parejas, ctx);
  return { ...e, ...plan };
}

const num = (digitos: string): NumeroFactura => ({
  serie: null,
  digitos,
  texto: digitos,
});

beforeEach(() => {
  orden = 0;
});

describe('lista blanca y utilidades', () => {
  it('las 9 leyendas sin concepto (6 de prod) en forma normalizarPlano', () => {
    expect(LEYENDAS_SIN_CONCEPTO).toHaveLength(9);
    expect(esLeyendaSinConcepto('SEL TRANSF. INTERBANCARIA SPEI')).toBe(true);
    expect(esLeyendaSinConcepto('TRANSF ENVIO SPEI BCA INTERNET')).toBe(true);
    expect(esLeyendaSinConcepto('03 POR COBRANZA DOMICILIADA')).toBe(true);
    expect(esLeyendaSinConcepto('SCN Pagos a Proveedores')).toBe(true);
    expect(esLeyendaSinConcepto('ASA CANCUN')).toBe(false);
    expect(esLeyendaSinConcepto(`${SPEI} BANORTE fact vip 7360`)).toBe(false);
  });

  it('extiendeLeyenda mide con normalizarPlano (descDedupe quitaría SEL/SPEI)', () => {
    const T = 'SEL TRANSF INTERBANCARIA SPEI';
    expect(extiendeLeyenda(T, `${SPEI} BANORTE fact vip 7360`)).toBe(true);
    expect(extiendeLeyenda(T, SPEI)).toBe(false);
    expect(extiendeLeyenda(T, 'SPEI ENVIADO BANORTE fact vip 7341')).toBe(
      false,
    );
  });

  it('descripcionParaGuardar: espacios simples, recorte y tope de 200', () => {
    expect(descripcionParaGuardar('  SEL   TRANSF.\tSPEI  ')).toBe(
      'SEL TRANSF. SPEI',
    );
    expect(descripcionParaGuardar('   ')).toBeNull();
    expect(descripcionParaGuardar(null)).toBeNull();
    expect(descripcionParaGuardar('x'.repeat(250))).toHaveLength(200);
  });

  it('elegible = IMPORTADO sin vínculo no bancario; virgen = sin ligas ni notas', () => {
    const p = P('a', '2026-09-07', 1, SPEI);
    expect(esPreviaElegible(p)).toBe(true);
    expect(esFilaVirgen(p)).toBe(true);
    expect(esPreviaElegible({ ...p, origen: 'MANUAL' })).toBe(false);
    expect(esFilaVirgen({ ...p, gastos_n: 2 })).toBe(false);
    expect(esFilaVirgen({ ...p, notas: 'algo' })).toBe(false);
    expect(esFilaVirgen({ ...p, conciliado: true })).toBe(false);
    expect(esFilaVirgen({ ...p, conciliado: undefined })).toBe(false);
    expect(esFilaVirgen({ ...p, reverso_de_id: 'x' })).toBe(false);
  });

  it('direccionDeFechas', () => {
    expect(direccionDeFechas(['2026-09-01', '2026-09-01', '2026-09-03'])).toBe(
      'ASC',
    );
    expect(direccionDeFechas(['2026-09-30', '2026-09-02'])).toBe('DESC');
    expect(direccionDeFechas(['2026-09-01', '2026-09-03', '2026-09-02'])).toBe(
      null,
    );
    expect(direccionDeFechas(['2026-09-01', '2026-09-01'])).toBe(null);
    expect(direccionDeFechas(['2026-09-01'])).toBe(null);
  });

  it('lineasNuevasEnBucketConocido: solo las que caen en un bucket con previas', () => {
    const previos = [P('a', '2026-09-21', '16.00', '04266QGJ580051065430')];
    const nuevas = [
      N('2026-09-21', '16.00', 'SEL PAGO DE SERVICIOS PAGO REFERENCIADO SAT'),
      N('2026-09-21', '17.00', 'OTRA'),
    ];
    expect(lineasNuevasEnBucketConocido(nuevas, previos)).toEqual([nuevas[0]]);
  });
});

describe('planEnriquecimiento — los 20 escenarios del prototipo', () => {
  it('1×1 ligado ⇒ UNICO con el texto limpio', () => {
    const r = correr(
      [N('2026-09-30', '2231.38', `${SPEI}  BANORTE fact vip 7341`)],
      [
        P('p1', '2026-09-30', '2231.38', SPEI, {
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(0);
    expect(r.enriquecer).toEqual([
      {
        previo_id: 'p1',
        fecha: '2026-09-30',
        tipo: 'CARGO',
        monto: 2231.38,
        antes: SPEI,
        despues: `${SPEI} BANORTE fact vip 7341`,
        regla: 'UNICO',
        orden_archivo_nuevo: 1,
      },
    ]);
    expect(r.omitidos).toEqual([]);
  });

  it('gemelos 07-sep ligados SIN folio ⇒ GEMELOS con los 2 ids, 2 conceptos y sus facturas', () => {
    const r = correr(
      [
        N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7350`),
        N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7351`),
      ],
      [
        P('a', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g1',
          gastos_n: 1,
        }),
        P('b', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g2',
          gastos_n: 1,
        }),
      ],
      { moneda: 'MXN' },
    );
    expect(r.duplicados).toBe(2);
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toEqual([
      {
        motivo: 'GEMELOS',
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 1118.12,
        moneda: 'MXN',
        movimiento_ids: ['a', 'b'],
        conceptos: [
          `${SPEI} BANORTE fact vip 7350`,
          `${SPEI} BANORTE fact vip 7351`,
        ],
        facturas: ['Factura 7350', 'Factura 7351'],
      },
    ]);
  });

  it('los mismos gemelos con folios CRUZADOS ⇒ FOLIO, cada uno con el suyo', () => {
    const nuevos = [
      N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7350`),
      N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7351`),
    ];
    const previos = [
      P('a', '2026-09-07', '1118.12', SPEI, {
        conciliado: true,
        gasto_id: 'g1',
        gastos_n: 1,
      }),
      P('b', '2026-09-07', '1118.12', SPEI, {
        conciliado: true,
        gasto_id: 'g2',
        gastos_n: 1,
      }),
    ];
    const r = correr(nuevos, previos, {
      foliosPorPrevia: new Map([
        ['a', [num('7351')]],
        ['b', [num('7350')]],
      ]),
    });
    const porId = Object.fromEntries(
      r.enriquecer.map((e) => [e.previo_id, `${e.regla}:${e.despues}`]),
    );
    expect(porId).toEqual({
      a: `FOLIO:${SPEI} BANORTE fact vip 7351`,
      b: `FOLIO:${SPEI} BANORTE fact vip 7350`,
    });
    // Los ids que hay que leer para esa regla.
    expect(idsParaLeerFolios(nuevos, previos, r.parejas).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('vírgenes 15-sep ⇒ INTERCAMBIABLES (cualquier asignación deja lo mismo a la vista)', () => {
    const r = correr(
      [
        N('2026-09-15', '4725.60', `${SPEI} BANORTE fact x 7301`),
        N('2026-09-15', '4725.60', `${SPEI} BANORTE fact x 7302`),
      ],
      [
        P('a', '2026-09-15', '4725.60', SPEI),
        P('b', '2026-09-15', '4725.60', SPEI),
      ],
    );
    expect(r.enriquecer.map((e) => e.regla)).toEqual([
      'INTERCAMBIABLES',
      'INTERCAMBIABLES',
    ]);
    expect(new Set(r.enriquecer.map((e) => e.previo_id))).toEqual(
      new Set(['a', 'b']),
    );
    expect(r.enriquecer.map((e) => e.despues).sort()).toEqual([
      `${SPEI} BANORTE fact x 7301`,
      `${SPEI} BANORTE fact x 7302`,
    ]);
  });

  it('mixto 24-sep (uno ligado con «fact 7331» y uno libre) ⇒ FOLIO; sin el folio ⇒ GEMELOS', () => {
    const nuevos = () => [
      N('2026-09-24', '1118.12', `${SPEI} BANORTE fact vip 7330`, { orden: 1 }),
      N('2026-09-24', '1118.12', `${SPEI} BANORTE fact vip 7331`, { orden: 2 }),
    ];
    const previos = () => [
      P('lig', '2026-09-24', '1118.12', SPEI, {
        conciliado: true,
        gasto_id: 'g255',
        gastos_n: 1,
      }),
      P('lib', '2026-09-24', '1118.12', SPEI),
    ];
    const conFolio = correr(nuevos(), previos(), {
      foliosPorPrevia: new Map([['lig', [num('7331')]]]),
    });
    expect(
      Object.fromEntries(
        conFolio.enriquecer.map((e) => [e.previo_id, e.despues.slice(-4)]),
      ),
    ).toEqual({ lig: '7331', lib: '7330' });
    expect(conFolio.enriquecer.every((e) => e.regla === 'FOLIO')).toBe(true);

    const sinFolio = correr(nuevos(), previos());
    expect(sinFolio.enriquecer).toEqual([]);
    expect(sinFolio.omitidos.map((o) => [o.motivo, o.movimiento_ids])).toEqual([
      ['GEMELOS', ['lig', 'lib']],
    ]);
  });

  it('2 ligadas + 1 línea ⇒ GEMELOS', () => {
    const r = correr(
      [N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7350`)],
      [
        P('a', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g1',
        }),
        P('b', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g2',
        }),
      ],
    );
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos[0]).toMatchObject({
      motivo: 'GEMELOS',
      movimiento_ids: ['a', 'b'],
      conceptos: [`${SPEI} BANORTE fact vip 7350`],
    });
  });

  it('el MISMO texto en 2 lotes ⇒ MISMO_TEXTO', () => {
    const r = correr(
      [
        N('2026-09-24', '4462.75', `${SPEI} BANORTE fact vip 7300`),
        N('2026-09-24', '4462.75', `${SPEI} BANORTE fact vip 7300`),
      ],
      [
        P('a', '2026-09-24', '4462.75', SPEI, {
          conciliado: true,
          gastos_n: 2,
        }),
        P('b', '2026-09-24', '4462.75', SPEI, {
          conciliado: true,
          gastos_n: 2,
        }),
      ],
    );
    expect(r.enriquecer.map((e) => [e.previo_id, e.regla])).toEqual([
      ['a', 'MISMO_TEXTO'],
      ['b', 'MISMO_TEXTO'],
    ]);
  });

  it('abonos 09-sep de $1,000 con referencias DISTINTAS que la relectura repite ⇒ REFERENCIA', () => {
    const r = correr(
      [
        N(
          '2026-09-09',
          '1000.00',
          'TRANSF INTERBANCARIA SPEI TRASLADO A /BBVA',
          {
            tipo: 'ABONO',
            ref: '00000000000001408260',
          },
        ),
        N(
          '2026-09-09',
          '1000.00',
          'TRANSF INTERBANCARIA SPEI TRASLADO B /BANORTE',
          { tipo: 'ABONO', ref: '00000000000007645936' },
        ),
      ],
      [
        P('x', '2026-09-09', '1000.00', 'TRANSF INTERBANCARIA SPEI', {
          tipo: 'ABONO',
          ref: '00000000000001408260',
          conciliado: true,
          cobro_id: 'c1',
          cobros_n: 1,
        }),
        P('y', '2026-09-09', '1000.00', 'TRANSF INTERBANCARIA SPEI', {
          tipo: 'ABONO',
          ref: '00000000000007645936',
          conciliado: true,
          cobro_id: 'c2',
          cobros_n: 1,
        }),
      ],
    );
    expect(
      Object.fromEntries(r.enriquecer.map((e) => [e.previo_id, e.despues])),
    ).toEqual({
      x: 'TRANSF INTERBANCARIA SPEI TRASLADO A /BBVA',
      y: 'TRANSF INTERBANCARIA SPEI TRASLADO B /BANORTE',
    });
    expect(r.enriquecer.every((e) => e.regla === 'REFERENCIA')).toBe(true);
  });

  it('abonos de $1,700 con la MISMA referencia (uno con cobro) ⇒ GEMELOS', () => {
    const r = correr(
      [
        N('2026-09-15', '1700.00', 'TRANSF INTERBANCARIA SPEI PAX A', {
          tipo: 'ABONO',
          ref: '00000000000000150926',
        }),
        N('2026-09-15', '1700.00', 'TRANSF INTERBANCARIA SPEI PAX B', {
          tipo: 'ABONO',
          ref: '00000000000000150926',
        }),
      ],
      [
        P('x', '2026-09-15', '1700.00', 'TRANSF INTERBANCARIA SPEI', {
          tipo: 'ABONO',
          ref: '00000000000000150926',
          conciliado: true,
          cobro_id: 'c1',
          cobros_n: 1,
        }),
        P('y', '2026-09-15', '1700.00', 'TRANSF INTERBANCARIA SPEI', {
          tipo: 'ABONO',
          ref: '00000000000000150926',
        }),
      ],
    );
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toHaveLength(1);
    expect(r.omitidos[0]).toMatchObject({
      motivo: 'GEMELOS',
      tipo: 'ABONO',
      movimiento_ids: ['x', 'y'],
    });
  });

  it('«ASA CANCUN» no es leyenda: no se completa (con un prefijo genérico recibiría «ASA CANCUN I»)', () => {
    const r = correr(
      [N('2026-09-21', '825.13', 'ASA CANCUN I\\CARR CANC')],
      [P('a', '2026-09-21', '825.13', 'ASA CANCUN')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toEqual([]);
  });

  it('renglón principal reescrito («SPEI ENVIADO…») ⇒ se insertaría y NO completa nada', () => {
    const r = correr(
      [N('2026-09-30', '2231.38', 'SPEI ENVIADO BANORTE fact vip 7341')],
      [
        P('p1', '2026-09-30', '2231.38', SPEI, {
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.aInsertar).toHaveLength(1);
    expect(r.enriquecer).toEqual([]);
    expect(
      lineasNuevasEnBucketConocido(r.aInsertar, [
        P('p1', '2026-09-30', '2231.38', SPEI),
      ]),
    ).toHaveLength(1);
  });

  it('clave de rastreo del 21-sep ⇒ no se completa (se insertaría)', () => {
    const r = correr(
      [
        N(
          '2026-09-21',
          '16.00',
          'SEL PAGO DE SERVICIOS PAGO REFERENCIADO SAT',
          {
            ref: '00000000000185345370',
          },
        ),
      ],
      [
        P('r', '2026-09-21', '16.00', '04266QGJ580051065430', {
          ref: '00000000000185345370',
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.aInsertar).toHaveLength(1);
    expect(r.enriquecer).toEqual([]);
  });

  it('una fila YA completada no se toca (idempotencia)', () => {
    const r = correr(
      [N('2026-09-30', '2231.38', `${SPEI} BANORTE fact vip 7341`)],
      [
        P('p1', '2026-09-30', '2231.38', `${SPEI} BANORTE fact vip 7341`, {
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.duplicados).toBe(1);
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toEqual([]);
  });

  it('vínculo NO bancario (invariante 48) ⇒ VINCULO_NO_BANCARIO, jamás se escribe', () => {
    const r = correr(
      [N('2026-09-30', '212.00', `${SPEI} BANORTE fact 99`)],
      [
        P('v', '2026-09-30', '212.00', SPEI, {
          conciliado: true,
          gasto_id: 'g',
          notas:
            'Vinculado a gasto en EFECTIVO del 28-sep-2026 (Taxi / estacionamiento · vuelo #330 · $212.00 · gasto 3f9a1c2e): razón — Mari, 06-oct-2026',
        }),
      ],
    );
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toEqual([
      expect.objectContaining({
        motivo: 'VINCULO_NO_BANCARIO',
        movimiento_ids: ['v'],
        conceptos: [`${SPEI} BANORTE fact 99`],
        facturas: ['Factura 99'],
      }),
    ]);
  });

  it('línea igual + línea con concepto: en 2 vírgenes ⇒ una INTERCAMBIABLES; en 2 ligadas ⇒ GEMELOS', () => {
    const virgenes = correr(
      [
        N('2026-09-22', '1.00', SPEI),
        N('2026-09-22', '1.00', `${SPEI} BANORTE prueba`),
      ],
      [P('a', '2026-09-22', '1.00', SPEI), P('b', '2026-09-22', '1.00', SPEI)],
    );
    expect(virgenes.enriquecer).toHaveLength(1);
    expect(virgenes.enriquecer[0]).toMatchObject({
      regla: 'INTERCAMBIABLES',
      despues: `${SPEI} BANORTE prueba`,
    });

    const ligadas = correr(
      [
        N('2026-09-07', '1118.12', SPEI),
        N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7351`),
      ],
      [
        P('a', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g1',
        }),
        P('b', '2026-09-07', '1118.12', SPEI, {
          conciliado: true,
          gasto_id: 'g2',
        }),
      ],
    );
    expect(ligadas.enriquecer).toEqual([]);
    expect(ligadas.omitidos[0]).toMatchObject({
      motivo: 'GEMELOS',
      conceptos: [`${SPEI} BANORTE fact vip 7351`],
    });
  });

  it('7 comisiones de $7 con referencias nuevas ⇒ 7 INTERCAMBIABLES', () => {
    const previos = Array.from({ length: 7 }, (_, i) =>
      P(`c${i}`, '2026-09-24', '7.00', 'TRANSF ENVIO SPEI BCA INTERNET', {
        ref: `0000000000019555${4100 + i}`,
      }),
    );
    const nuevos = Array.from({ length: 7 }, (_, i) =>
      N(
        '2026-09-24',
        '7.00',
        `TRANSF ENVIO SPEI BCA INTERNET COMISION SPEI ${i}`,
        { ref: `99999999${i}` },
      ),
    );
    const r = correr(nuevos, previos);
    expect(r.duplicados).toBe(7);
    expect(r.enriquecer).toHaveLength(7);
    expect(r.enriquecer.every((e) => e.regla === 'INTERCAMBIABLES')).toBe(true);
    expect(r.omitidos).toEqual([]);
  });

  it('bucket con una fila YA completada + 2 leyendas ⇒ las 2 se completan y la completa no se toca', () => {
    const r = correr(
      [
        N('2026-09-30', '4725.60', `${SPEI} BANORTE fact x 7301`),
        N('2026-09-30', '4725.60', `${SPEI} BANORTE fact x 7302`),
        N('2026-09-30', '4725.60', `${SPEI} BANORTE fact x 7303`),
      ],
      [
        P('x1', '2026-09-30', '4725.60', `${SPEI} BANORTE fact x 7301`),
        P('x2', '2026-09-30', '4725.60', SPEI),
        P('x3', '2026-09-30', '4725.60', SPEI),
      ],
    );
    expect(r.duplicados).toBe(3);
    expect(r.aInsertar).toHaveLength(0);
    expect(r.enriquecer.map((e) => e.previo_id).sort()).toEqual(['x2', 'x3']);
    expect(r.enriquecer.map((e) => e.despues.slice(-4)).sort()).toEqual([
      '7302',
      '7303',
    ]);
  });

  it('MANUAL nunca se escribe (ni se reporta)', () => {
    const r = correr(
      [N('2026-09-30', '2231.38', `${SPEI} BANORTE fact vip 7341`)],
      [
        P('m', '2026-09-30', '2231.38', SPEI, {
          origen: 'MANUAL',
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos).toEqual([]);
  });

  it('el plan nunca devuelve llaves fuera de las del tipo (ni montos, fechas ni ligas a escribir)', () => {
    const r = correr(
      [
        N('2026-09-15', '4725.60', `${SPEI} BANORTE fact x 7301`),
        N('2026-09-30', '2231.38', `${SPEI} BANORTE fact vip 7341`),
      ],
      [
        P('a', '2026-09-15', '4725.60', SPEI),
        P('p1', '2026-09-30', '2231.38', SPEI, {
          conciliado: true,
          gasto_id: 'g',
        }),
      ],
    );
    expect(r.enriquecer).toHaveLength(2);
    for (const e of r.enriquecer) {
      expect(Object.keys(e).sort()).toEqual(
        [
          'antes',
          'despues',
          'fecha',
          'monto',
          'orden_archivo_nuevo',
          'previo_id',
          'regla',
          'tipo',
        ].sort(),
      );
    }
  });
});

describe('ORDEN_ARCHIVO — gemelos de UN archivo con dirección conocida', () => {
  const gemelos = (dirPrevioAsc: boolean) => [
    P('a', '2026-09-07', '1118.12', SPEI, {
      conciliado: true,
      gasto_id: 'g1',
      estado_cuenta_id: 'ec-1',
      orden_archivo: dirPrevioAsc ? 10 : 20,
    }),
    P('b', '2026-09-07', '1118.12', SPEI, {
      conciliado: true,
      gasto_id: 'g2',
      estado_cuenta_id: 'ec-1',
      orden_archivo: dirPrevioAsc ? 11 : 21,
    }),
  ];
  const lineas = () => [
    N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7350`, { orden: 5 }),
    N('2026-09-07', '1118.12', `${SPEI} BANORTE fact vip 7351`, { orden: 6 }),
  ];

  it('ASC/ASC: la 1.ª fila del archivo viejo recibe la 1.ª línea del nuevo', () => {
    const nuevos = lineas();
    const previos = gemelos(true);
    const e = emparejarDuplicados(nuevos, previos);
    expect(estadoCuentaIdsParaDireccion(nuevos, previos, e.parejas)).toEqual([
      'ec-1',
    ]);
    const r = planEnriquecimiento(nuevos, previos, e.parejas, {
      direccionArchivoNuevo: 'ASC',
      direccionPorEstadoCuenta: new Map([['ec-1', 'ASC']]),
    });
    expect(
      Object.fromEntries(
        r.enriquecer.map((x) => [x.previo_id, x.despues.slice(-4)]),
      ),
    ).toEqual({ a: '7350', b: '7351' });
    expect(r.enriquecer.every((x) => x.regla === 'ORDEN_ARCHIVO')).toBe(true);
  });

  it('ASC/DESC: el orden se invierte', () => {
    const nuevos = lineas();
    const previos = gemelos(true);
    const e = emparejarDuplicados(nuevos, previos);
    const r = planEnriquecimiento(nuevos, previos, e.parejas, {
      direccionArchivoNuevo: 'DESC',
      direccionPorEstadoCuenta: new Map([['ec-1', 'ASC']]),
    });
    expect(
      Object.fromEntries(
        r.enriquecer.map((x) => [x.previo_id, x.despues.slice(-4)]),
      ),
    ).toEqual({ a: '7351', b: '7350' });
  });

  it('dirección desconocida ⇒ GEMELOS', () => {
    const nuevos = lineas();
    const previos = gemelos(true);
    const e = emparejarDuplicados(nuevos, previos);
    const r = planEnriquecimiento(nuevos, previos, e.parejas, {
      direccionArchivoNuevo: 'ASC',
      direccionPorEstadoCuenta: new Map([['ec-1', null]]),
    });
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos[0].motivo).toBe('GEMELOS');
  });

  it('archivos distintos ⇒ GEMELOS (y no se lee ninguna dirección)', () => {
    const nuevos = lineas();
    const previos = gemelos(true);
    previos[1] = { ...previos[1], estado_cuenta_id: 'ec-2' };
    const e = emparejarDuplicados(nuevos, previos);
    expect(estadoCuentaIdsParaDireccion(nuevos, previos, e.parejas)).toEqual(
      [],
    );
    const r = planEnriquecimiento(nuevos, previos, e.parejas, {
      direccionArchivoNuevo: 'ASC',
      direccionPorEstadoCuenta: new Map([
        ['ec-1', 'ASC'],
        ['ec-2', 'ASC'],
      ]),
    });
    expect(r.enriquecer).toEqual([]);
    expect(r.omitidos[0].motivo).toBe('GEMELOS');
  });
});
