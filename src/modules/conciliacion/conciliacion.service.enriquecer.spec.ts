import { BadRequestException } from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { sembrarPartes } from './conciliacion-partes.fixture-spec';
import {
  TipoMovimientoBancario,
  type MovimientoImportDto,
} from './dto/conciliacion.dto';
import {
  escrituras,
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from './conciliacion-postgrest.fixture-spec';

/**
 * CONCEPTO DEL SPEI AL RE-SUBIR EL ESTADO DE CUENTA (13-oct-2026, API
 * 0.0.75, invariante 69). Con un PostgREST falso que RESPETA `range`, el
 * tope de 1000 filas y el CAS por `eq`:
 * - re-subir septiembre NO inserta nada y solo escribe `descripcion` +
 *   `updated_by` con CAS (`eq descripcion` + `eq origen IMPORTADO`);
 * - el rastro va a `resultados` A MEDIO JOB y sobrevive a un error;
 * - `solo_enriquecer` no inserta, no cruza, no empareja reversos y lista
 *   lo no encontrado;
 * - la vista previa no escribe nada y cuenta lo mismo que la importación;
 * - los previos se leen PAGINADOS (el `.limit(20000)` de antes se cortaba
 *   en 1000 sin avisar).
 */
const CTA = 'cta-eje';
const USER = 'user-1';
const SPEI = 'SEL TRANSF. INTERBANCARIA SPEI';
const R = '00000000000000000001';

/** `correrImportJob` es privado: el job se corre directo (sin el `void`). */
function correrJob(
  svc: ConciliacionService,
  id: string,
  dto: unknown,
  user: string,
): Promise<void> {
  return (
    svc as unknown as {
      correrImportJob: (i: string, d: unknown, u: string) => Promise<void>;
    }
  ).correrImportJob(id, dto, user);
}

function armar(db: Tablas, opts: OpcionesFake = {}) {
  sembrarPartes(db);
  const fake = fakePostgrest(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    fake.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, ...fake };
}

const previo = (
  id: string,
  fecha: string,
  monto: number,
  descripcion: string,
  extra: Row = {},
): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha,
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion,
  referencia: R,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  estado_cuenta_id: 'ec-sep',
  created_at: '2026-10-01T00:00:00Z',
  updated_by: 'quien-importo',
  ...extra,
});

const linea = (
  fecha: string,
  monto: number,
  descripcion: string,
  extra: Partial<MovimientoImportDto> = {},
): MovimientoImportDto => ({
  fecha,
  tipo: TipoMovimientoBancario.CARGO,
  monto,
  descripcion,
  referencia: R,
  ...extra,
});

/** Septiembre de EJE SCOTIA en chiquito (casos reales de la especificación). */
function septiembre(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      { id: CTA, moneda: 'MXN', tipo: 'BANCO', alias: 'EJE SCOTIA' },
    ],
    tarjeta_corporativa: [],
    gasto: [
      {
        id: 'g1',
        monto: 2231.38,
        moneda: 'MXN',
        fecha_gasto: '2026-09-04',
        medio_pago: 'TRANSFERENCIA',
        conciliado: true,
        notas: 'Pago VIP SAESA',
      },
    ],
    movimiento_bancario: [
      previo('p1', '2026-09-04', 2231.38, SPEI, {
        conciliado: true,
        gasto_id: 'g1',
      }),
      previo('p2', '2026-09-15', 4725.6, SPEI),
      previo('p3', '2026-09-15', 4725.6, SPEI),
      previo('p4', '2026-09-21', 825.13, 'ASA CANCUN', { conciliado: true }),
      previo('p5', '2026-09-09', 1000, 'TRANSF INTERBANCARIA SPEI', {
        tipo: 'ABONO',
        conciliado: true,
        cobro_id: 'c1',
        cobros_n: 1,
      }),
    ],
    estado_cuenta_archivo: [],
    conciliacion_import_job: [],
    ...extra,
  };
}

const archivoSep = () => [
  linea('2026-09-04', 2231.38, `${SPEI} BANORTE fact vip 7341`),
  linea('2026-09-09', 1000, 'TRANSF INTERBANCARIA SPEI TRASLADO /BBVA', {
    tipo: TipoMovimientoBancario.ABONO,
  }),
  linea('2026-09-15', 4725.6, `${SPEI} BANORTE fact x 7301`),
  linea('2026-09-15', 4725.6, `${SPEI} BANORTE fact x 7302`),
  linea('2026-09-21', 825.13, 'ASA CANCUN'),
];

/** Lo que NO puede cambiar de una fila enriquecida. */
const intactas = (db: Tablas) =>
  (db.movimiento_bancario ?? []).map((m) => {
    const { descripcion, updated_by, ...resto } = m;
    void descripcion;
    void updated_by;
    return resto;
  });

describe('importar — re-subir septiembre completa el concepto SIN duplicar', () => {
  it('0 inserts; N updates con el cuerpo EXACTO {descripcion, updated_by} y CAS por texto + origen', async () => {
    const db = septiembre();
    const { svc, log } = armar(db);
    const antes = JSON.parse(JSON.stringify(intactas(db))) as Row[];
    const r = await svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    expect(r.importados).toBe(0);
    expect(r.duplicados_omitidos).toBe(5);
    expect(r.enriquecidos).toBe(4);
    expect(r.enriquecimiento_omitidos).toBe(0);
    expect(r.nuevos_mismo_dia_y_monto).toBe(0);
    expect(
      r.enriquecimiento?.detalle.map((d) => d.movimiento_id).sort(),
    ).toEqual(['p1', 'p2', 'p3', 'p5']);
    // Las únicas escrituras: 4 updates de descripción con CAS.
    const w = escrituras(log);
    expect(w).toHaveLength(4);
    for (const u of w) {
      expect(u.tabla).toBe('movimiento_bancario');
      expect(u.op).toBe('update');
      expect(Object.keys(u.cuerpo as Row).sort()).toEqual([
        'descripcion',
        'updated_by',
      ]);
      expect((u.cuerpo as Row).updated_by).toBe(USER);
      const id = u.filtros.find(([f, c]) => f === 'eq' && c === 'id')?.[2];
      const antesTxt = id === 'p5' ? 'TRANSF INTERBANCARIA SPEI' : SPEI;
      expect(u.filtros).toEqual(
        expect.arrayContaining([
          ['eq', 'descripcion', antesTxt],
          ['eq', 'origen', 'IMPORTADO'],
        ]),
      );
    }
    // Monto, fecha, conciliado, ligas y notas: idénticos.
    expect(intactas(db)).toEqual(antes);
    const desc: Record<string, unknown> = Object.fromEntries(
      db.movimiento_bancario.map((m): [string, unknown] => [
        m.id as string,
        m.descripcion,
      ]),
    );
    expect(desc.p1).toBe(`${SPEI} BANORTE fact vip 7341`);
    expect(desc.p4).toBe('ASA CANCUN');
    expect(desc.p5).toBe('TRANSF INTERBANCARIA SPEI TRASLADO /BBVA');
    expect([desc.p2, desc.p3].sort()).toEqual([
      `${SPEI} BANORTE fact x 7301`,
      `${SPEI} BANORTE fact x 7302`,
    ]);
  });

  it('re-subirlo OTRA vez es idempotente: nada que completar, nada escrito', async () => {
    const db = septiembre();
    await armar(db).svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    const { svc, log } = armar(db);
    const r = await svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    expect(r.enriquecidos).toBe(0);
    expect(r.duplicados_omitidos).toBe(5);
    expect(escrituras(log)).toEqual([]);
  });

  it('CAS sin filas ⇒ CAMBIO_CONCURRENTE; un error en 1 de 3 ⇒ las otras se aplican y el job termina LISTO', async () => {
    const db = septiembre({
      conciliacion_import_job: [{ id: 'job-1', estado: 'PROCESANDO' }],
    });
    const { svc } = armar(db, {
      antes: (op, base) => {
        if (op.tabla !== 'movimiento_bancario' || op.op !== 'update') return;
        const id = op.filtros.find(([f, c]) => f === 'eq' && c === 'id')?.[2];
        // La oficina editó p2 entre la lectura y la escritura.
        if (id === 'p2') {
          const fila = base.movimiento_bancario.find((m) => m.id === 'p2');
          if (fila) fila.descripcion = 'EDITADA POR LA OFICINA';
        }
        if (id === 'p5')
          return { message: 'canceling statement due to timeout' };
      },
    });
    await correrJob(
      svc,
      'job-1',
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    const job = db.conciliacion_import_job[0];
    expect(job.estado).toBe('LISTO');
    const res = job.resultados as Record<string, unknown>;
    expect(res.enriquecidos).toBe(2);
    expect(res.enriquecimiento_omitidos).toBe(2);
    const omitidos = (
      res.enriquecimiento as { omitidos: Array<Record<string, unknown>> }
    ).omitidos;
    // En el orden del archivo: p5 (línea 2) antes que p2 (línea 3).
    expect(omitidos.map((o) => [o.motivo, o.movimiento_ids])).toEqual([
      ['ERROR', ['p5']],
      ['CAMBIO_CONCURRENTE', ['p2']],
    ]);
    expect(omitidos[0].detalle).toBe('canceling statement due to timeout');
    expect(omitidos[1]).not.toHaveProperty('detalle');
    // La edición de la oficina NO se pisó.
    expect(db.movimiento_bancario.find((m) => m.id === 'p2')?.descripcion).toBe(
      'EDITADA POR LA OFICINA',
    );
  });

  it('el rastro parcial llega a `resultados` y SOBREVIVE a un error posterior (el insert truena ⇒ ERROR)', async () => {
    const db = septiembre({
      conciliacion_import_job: [{ id: 'job-2', estado: 'PROCESANDO' }],
    });
    const { svc } = armar(db, {
      fallos: { 'movimiento_bancario:insert': { message: 'insert caído' } },
    });
    await correrJob(
      svc,
      'job-2',
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          ...archivoSep(),
          linea('2026-09-30', 99.99, 'UNA LINEA NUEVA'),
        ],
      },
      USER,
    );
    const job = db.conciliacion_import_job[0];
    expect(job.estado).toBe('ERROR');
    expect(job.error).toBe('insert caído');
    const res = job.resultados as Record<string, unknown>;
    expect(res.enriquecidos).toBe(4);
    expect(
      (res.enriquecimiento as { detalle: unknown[] }).detalle,
    ).toHaveLength(4);
  });
});

describe('solo_enriquecer — no inserta, no cruza, lista lo no encontrado', () => {
  it('cero inserts de movimientos, cero cruces y cero reversos; el archivo queda con 0 importados', async () => {
    const db = septiembre();
    const { svc, log, storage } = armar(db);
    const cruzar = jest.spyOn(
      svc as unknown as { cruzarMovimiento: () => Promise<unknown> },
      'cruzarMovimiento',
    );
    const reversos = jest.spyOn(
      svc as unknown as { aplicarReversosEnCorrida: () => Promise<number> },
      'aplicarReversosEnCorrida',
    );
    const r = await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        filename: 'scotia eje sep.pdf',
        file_base64: Buffer.from('%PDF').toString('base64'),
        solo_enriquecer: true,
        movimientos: [
          ...archivoSep(),
          linea('2026-09-21', 16, '04266QGJ580051065430 fact 7777', {
            referencia: '00000000000185345370',
          }),
        ],
      },
      USER,
    );
    expect(cruzar).not.toHaveBeenCalled();
    expect(reversos).not.toHaveBeenCalled();
    expect(r.solo_enriquecer).toBe(true);
    expect(r.importados).toBe(0);
    expect(r.conciliados_auto).toBe(0);
    expect(r.enriquecidos).toBe(4);
    expect(r.no_encontrados).toBe(1);
    expect(r.no_encontrados_detalle).toEqual([
      {
        orden_archivo: 6,
        fecha: '2026-09-21',
        tipo: 'CARGO',
        monto: 16,
        moneda: 'MXN',
        descripcion: '04266QGJ580051065430 fact 7777',
        referencia: '00000000000185345370',
        factura: 'Factura 7777',
      },
    ]);
    expect(r).not.toHaveProperty('nuevos_mismo_dia_y_monto');
    // Se archivó el PDF y quedó con 0 movimientos importados.
    expect(storage).toHaveLength(1);
    expect(db.estado_cuenta_archivo).toHaveLength(1);
    expect(db.estado_cuenta_archivo[0].movimientos_importados).toBe(0);
    expect(
      escrituras(log).filter(
        (o) => o.tabla === 'movimiento_bancario' && o.op === 'insert',
      ),
    ).toEqual([]);
    expect(db.movimiento_bancario).toHaveLength(5);
  });

  it('modo normal: la línea nueva con misma fecha y monto se avisa (y sí se inserta)', async () => {
    const db = septiembre();
    const { svc } = armar(db);
    jest
      .spyOn(
        svc as unknown as { cruzarMovimiento: () => Promise<unknown> },
        'cruzarMovimiento',
      )
      .mockResolvedValue({
        movimiento_id: 'x',
        resultado: 'SIN_CANDIDATO',
        criterio: null,
        motivo: 'sin candidatos',
        candidatos_n: 0,
      });
    jest
      .spyOn(
        svc as unknown as { aplicarReversosEnCorrida: () => Promise<number> },
        'aplicarReversosEnCorrida',
      )
      .mockResolvedValue(0);
    const r = await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          ...archivoSep(),
          linea('2026-09-21', 825.13, '04266QF5580051069411'),
        ],
      },
      USER,
    );
    expect(r.importados).toBe(1);
    expect(r.nuevos_mismo_dia_y_monto).toBe(1);
    expect(r.nuevos_mismo_dia_y_monto_detalle).toEqual([
      {
        orden_archivo: 6,
        fecha: '2026-09-21',
        tipo: 'CARGO',
        monto: 825.13,
        moneda: 'MXN',
        descripcion: '04266QF5580051069411',
      },
    ]);
    expect(r).not.toHaveProperty('solo_enriquecer');
    expect(r).not.toHaveProperty('no_encontrados');
  });
});

describe('vista previa — no escribe nada y cuenta lo mismo que la importación', () => {
  it('sin insert, update ni Storage; los conteos coinciden con los del importar', async () => {
    const db = septiembre();
    const dto = {
      cuenta_bancaria_id: CTA,
      filename: 'scotia eje sep.pdf',
      file_base64: Buffer.from('%PDF').toString('base64'),
      movimientos: [
        ...archivoSep(),
        linea('2026-09-21', 825.13, '04266QF5580051069411'),
        linea('2026-09-30', 50, 'OTRA NUEVA'),
      ],
    };
    const vista = armar(db);
    const v = await vista.svc.vistaPreviaImport(dto);
    expect(escrituras(vista.log)).toEqual([]);
    expect(vista.storage).toEqual([]);
    expect(db.estado_cuenta_archivo).toEqual([]);
    expect(v).toMatchObject({
      total: 7,
      ya_estaban: 5,
      nuevos: 2,
      nuevos_mismo_dia_y_monto: 1,
      se_enriquecen: 4,
      enriquecimiento_omitidos: 0,
      moneda: 'MXN',
      omitidos: [],
    });
    expect(v.nuevos_detalle).toEqual([
      {
        orden_archivo: 6,
        fecha: '2026-09-21',
        tipo: 'CARGO',
        monto: 825.13,
        descripcion: '04266QF5580051069411',
        mismo_dia_y_monto: true,
      },
      {
        orden_archivo: 7,
        fecha: '2026-09-30',
        tipo: 'CARGO',
        monto: 50,
        descripcion: 'OTRA NUEVA',
        mismo_dia_y_monto: false,
      },
    ]);
    expect(v.enriquecibles_detalle.map((e) => e.movimiento_id).sort()).toEqual([
      'p1',
      'p2',
      'p3',
      'p5',
    ]);

    const imp = armar(db);
    jest
      .spyOn(
        imp.svc as unknown as { cruzarMovimiento: () => Promise<unknown> },
        'cruzarMovimiento',
      )
      .mockResolvedValue({
        movimiento_id: 'x',
        resultado: 'SIN_CANDIDATO',
        criterio: null,
        motivo: null,
        candidatos_n: 0,
      });
    jest
      .spyOn(
        imp.svc as unknown as {
          aplicarReversosEnCorrida: () => Promise<number>;
        },
        'aplicarReversosEnCorrida',
      )
      .mockResolvedValue(0);
    const r = await imp.svc.importar(dto, USER);
    expect(r.duplicados_omitidos).toBe(v.ya_estaban);
    expect(r.importados).toBe(v.nuevos);
    expect(r.enriquecidos).toBe(v.se_enriquecen);
    expect(r.enriquecimiento_omitidos).toBe(v.enriquecimiento_omitidos);
    expect(r.nuevos_mismo_dia_y_monto).toBe(v.nuevos_mismo_dia_y_monto);
  });
});

describe('lecturas de la importación', () => {
  it('previos con 1001 filas ⇒ 2 páginas sin perder ninguna (la 1001 se encuentra y se completa)', async () => {
    const relleno = Array.from({ length: 1000 }, (_, i) =>
      previo(`a${String(i).padStart(4, '0')}`, '2026-09-10', 10000 + i, 'OTRA'),
    );
    const db = septiembre({
      movimiento_bancario: [
        ...relleno,
        previo('z-objetivo', '2026-09-10', 1118.12, SPEI, {
          conciliado: true,
          gasto_id: 'g1',
        }),
      ],
    });
    const { svc, log } = armar(db);
    const r = await svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [
          linea('2026-09-10', 1118.12, `${SPEI} BANORTE fact vip 7350`),
        ],
      },
      USER,
    );
    expect(r.duplicados_omitidos).toBe(1);
    expect(r.importados).toBe(0);
    expect(r.enriquecidos).toBe(1);
    const paginas = log.filter(
      (o) =>
        o.tabla === 'movimiento_bancario' &&
        o.op === 'select' &&
        o.sel.includes('estado_cuenta_id'),
    );
    expect(paginas.map((p) => p.rango)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(paginas[0].orden).toEqual([['id', true]]);
  });

  it('20 páginas llenas ⇒ 400 «impórtalo por partes» (jamás una foto recortada)', async () => {
    const muchas = Array.from({ length: 20000 }, (_, i) =>
      previo(`m${String(i).padStart(5, '0')}`, '2026-09-10', 1 + i, 'X'),
    );
    const db = septiembre({ movimiento_bancario: muchas });
    const { svc } = armar(db);
    const p = svc.importar(
      {
        cuenta_bancaria_id: CTA,
        movimientos: [linea('2026-09-10', 5, 'X')],
      },
      USER,
    );
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(
      'El periodo del archivo trae más de 20,000 movimientos previos en la cuenta: impórtalo por partes.',
    );
  });

  it('sondas apagadas (orden_archivo, reverso_de_id) ⇒ el select de previos no las nombra', async () => {
    const db = septiembre();
    const { svc, log } = armar(db, {
      ausentes: { movimiento_bancario: ['orden_archivo', 'reverso_de_id'] },
    });
    const r = await svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    expect(r.enriquecidos).toBe(4);
    const previos = log.find(
      (o) =>
        o.tabla === 'movimiento_bancario' &&
        o.op === 'select' &&
        o.sel.includes('estado_cuenta_id'),
    );
    expect(previos?.sel).not.toMatch(/orden_archivo|reverso_de_id/);
  });

  it('con las sondas encendidas el select lleva orden_archivo y reverso_de_id', async () => {
    const db = septiembre();
    const { svc, log } = armar(db);
    await svc.importar(
      { cuenta_bancaria_id: CTA, movimientos: archivoSep() },
      USER,
    );
    const previos = log.find(
      (o) =>
        o.tabla === 'movimiento_bancario' &&
        o.op === 'select' &&
        o.sel.includes('estado_cuenta_id'),
    );
    expect(previos?.sel).toMatch(/orden_archivo/);
    expect(previos?.sel).toMatch(/reverso_de_id/);
  });

  describe('gemelos ligados: los folios se leen por la puente', () => {
    const gemelosDb = () =>
      septiembre({
        gasto: [
          {
            id: 'g-a',
            monto: 1118.12,
            moneda: 'MXN',
            fecha_gasto: '2026-09-07',
            medio_pago: 'TRANSFERENCIA',
            conciliado: true,
            folio_ticket: '7351',
          },
          {
            id: 'g-b',
            monto: 1118.12,
            moneda: 'MXN',
            fecha_gasto: '2026-09-07',
            medio_pago: 'TRANSFERENCIA',
            conciliado: true,
            notas: 'Pago VIP SAESA fact 7350',
          },
        ],
        movimiento_bancario: [
          previo('tw-a', '2026-09-07', 1118.12, SPEI, {
            conciliado: true,
            gasto_id: 'g-a',
          }),
          previo('tw-b', '2026-09-07', 1118.12, SPEI, {
            conciliado: true,
            gasto_id: 'g-b',
          }),
        ],
      });
    const archivo = () => [
      linea('2026-09-07', 1118.12, `${SPEI} BANORTE fact vip 7350`),
      linea('2026-09-07', 1118.12, `${SPEI} BANORTE fact vip 7351`),
    ];

    it('regla FOLIO: cada fila recibe la factura de SU gasto', async () => {
      const db = gemelosDb();
      const { svc, log } = armar(db);
      const r = await svc.importar(
        { cuenta_bancaria_id: CTA, movimientos: archivo() },
        USER,
      );
      expect(r.enriquecidos).toBe(2);
      expect(
        Object.fromEntries(
          db.movimiento_bancario.map((m) => [
            m.id,
            String(m.descripcion).slice(-4),
          ]),
        ),
      ).toEqual({ 'tw-a': '7351', 'tw-b': '7350' });
      expect(
        log.some(
          (o) => o.tabla === 'movimiento_bancario_gasto' && o.op === 'select',
        ),
      ).toBe(true);
    });

    it('si la lectura de la puente falla quedan GEMELOS (con sus facturas) y la importación sigue', async () => {
      const db = gemelosDb();
      const { svc, log } = armar(db, {
        fallos: {
          'movimiento_bancario_gasto:select': { message: 'puente caída' },
        },
      });
      const r = await svc.importar(
        { cuenta_bancaria_id: CTA, movimientos: archivo() },
        USER,
      );
      expect(r.enriquecidos).toBe(0);
      expect(r.enriquecimiento_omitidos).toBe(2);
      expect(r.enriquecimiento?.omitidos).toEqual([
        expect.objectContaining({
          motivo: 'GEMELOS',
          movimiento_ids: ['tw-a', 'tw-b'],
          facturas: ['Factura 7350', 'Factura 7351'],
          moneda: 'MXN',
        }),
      ]);
      expect(escrituras(log)).toEqual([]);
    });
  });
});
