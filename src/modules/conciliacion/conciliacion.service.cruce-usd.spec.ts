import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  FUENTE_DIARIA,
  FUENTE_HISTORICA,
  tcOficialVigente,
  type OficialDiaTc,
  type TipoCambioService,
} from '../tipo-cambio/tipo-cambio.service';
import { sembrarPartes } from './conciliacion-partes.fixture-spec';
import {
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from './conciliacion-postgrest.fixture-spec';
import {
  TEXTO_CRUCE_USD_RECIPROCO_ERROR,
  TEXTO_CRUCE_USD_SIN_LECTURA_TC,
  TEXTO_CRUCE_USD_TRUNCADO,
} from './auto-cruce.util';
import {
  TipoMovimientoBancario,
  type MovimientoImportDto,
} from './dto/conciliacion.dto';

/**
 * GASTO EN DÓLARES ↔ CARGO EN PESOS: SOLO CON EL T.C. OFICIAL DEL DÍA DEL
 * CARGO (13-oct-2026, lote 2, API 0.0.75, invariante 70). Caso REAL de
 * Aircraft Spruce con los datos de prod: el tubo Michelin (422.86 USD,
 * 01-sep) quedó ligado a «ASA CANCUN» $8,939.38 de COMBUSTIBLE (T.C. 21.14
 * contra un oficial de 17.01, +24.3 %) y las bujías (794.61 USD, 24-sep) a
 * «ASA CANCUN I\CARR CANC» $14,197.17 (+2.3 %), mientras sus cargos reales
 * «AIRCRAFT SPRUCE AND SP» ($7,214.14 y $14,431.18) seguían pendientes.
 */
const COMB = 'cta-combustible';
const GG = 'cta-gg';
const USER = 'user-1';
const TUBO =
  'Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00-6 Straight Valve Stem (x2)';
const BUJIAS =
  '1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 108, 1 llanta Goodyear 6.00-6';

/** T.C. oficial (filas reales de la tabla que citan las ligas de prod). */
const OFICIALES: Array<{ fecha: string; tc: number; fuente: string }> = [
  { fecha: '2026-07-24', tc: 17.4803, fuente: FUENTE_HISTORICA },
  { fecha: '2026-08-04', tc: 17.2881, fuente: FUENTE_HISTORICA },
  { fecha: '2026-08-21', tc: 16.898, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-01', tc: 17.0077, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-04', tc: 16.9479, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-24', tc: 17.4691, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-29', tc: 17.8992, fuente: FUENTE_DIARIA },
  { fecha: '2026-10-12', tc: 18.4067, fuente: FUENTE_DIARIA },
];

/** TipoCambioService falso: la tabla de arriba con el respaldo de 7 días. */
function tipoCambioFalso(
  modo: 'tabla' | 'vacio' | 'falla' = 'tabla',
): TipoCambioService & { oficialesPorDias: jest.Mock } {
  const desc = [...OFICIALES].sort((a, b) =>
    String(a.fecha) < String(b.fecha) ? 1 : -1,
  );
  return {
    oficialesPorDias: jest.fn((dias: string[]) => {
      if (modo === 'falla') return Promise.resolve(null);
      const out = new Map<string, OficialDiaTc>();
      if (modo === 'vacio') return Promise.resolve(out);
      for (const d of dias) {
        const o = tcOficialVigente(desc, d);
        if (o) out.set(d, o);
      }
      return Promise.resolve(out);
    }),
  } as unknown as TipoCambioService & { oficialesPorDias: jest.Mock };
}

function armar(
  db: Tablas,
  opts: { fake?: OpcionesFake; tc?: TipoCambioService | null } = {},
) {
  sembrarPartes(db);
  const fake = fakePostgrest(db, opts.fake);
  const tc = opts.tc === undefined ? tipoCambioFalso() : opts.tc;
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    fake.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
    undefined,
    tc ?? undefined,
  );
  return { svc, tc, ...fake };
}

const gastoUsd = (
  id: string,
  monto: number,
  fecha: string,
  extra: Row = {},
): Row => ({
  id,
  monto,
  moneda: 'USD',
  fecha_gasto: fecha,
  medio_pago: 'TARJETA_CORP',
  conciliado: false,
  tc_gasto: null,
  tarjeta_terminacion: null,
  lugar: null,
  notas: null,
  categoria: 'REFACCION',
  vuelo_id: null,
  proveedor_id: null,
  folio_ticket: null,
  factura_recibida_id: null,
  ...extra,
});

const gastoMxn = (
  id: string,
  monto: number,
  fecha: string,
  extra: Row = {},
): Row =>
  gastoUsd(id, monto, fecha, {
    moneda: 'MXN',
    categoria: 'COMBUSTIBLE',
    ...extra,
  });

const mov = (
  id: string,
  fecha: string,
  monto: number,
  descripcion: string,
  extra: Row = {},
): Row => ({
  id,
  cuenta_bancaria_id: COMB,
  fecha,
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion,
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: `${fecha}T12:00:00Z`,
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      { id: COMB, moneda: 'MXN', tipo: 'BANCO', alias: 'COMBUSTIBLE' },
      { id: GG, moneda: 'MXN', tipo: 'BANCO', alias: 'GASTOS GNRAL' },
    ],
    tarjeta_corporativa: [],
    proveedor: [],
    vuelo: [],
    factura_recibida: [],
    conciliacion_clasificacion: [],
    estado_cuenta_archivo: [],
    gasto: [],
    movimiento_bancario: [],
    ...extra,
  };
}

const linea = (
  fecha: string,
  monto: number,
  descripcion: string,
): MovimientoImportDto => ({
  fecha,
  tipo: TipoMovimientoBancario.CARGO,
  monto,
  descripcion,
});

type Resultado = Record<string, unknown> & {
  detalle: Array<{
    resultado: string;
    motivo: string | null;
    criterio: string | null;
  }>;
  por_criterio: Record<string, number>;
};

async function importar(
  svc: ConciliacionService,
  movimientos: MovimientoImportDto[],
  cuenta = COMB,
): Promise<Resultado> {
  const r: Record<string, unknown> = await svc.importar(
    { cuenta_bancaria_id: cuenta, movimientos },
    USER,
  );
  return r as Resultado;
}

describe('auto-cruce USD ↔ MXN (importación y «Cruzar pendientes»)', () => {
  it('AIRCRAFT $7,214.14 + el tubo (nota real) + oficial 17.0077 ⇒ liga por TC_IMPLICITO', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db);
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.conciliados).toBe(1);
    expect(r.por_criterio.TC_IMPLICITO).toBe(1);
    expect(db.movimiento_bancario[0].gasto_id).toBe('tubo');
  });

  it('ASA $8,939.38 + el tubo ⇒ NO liga y el motivo dice el desvío (+24.3 %)', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db);
    const r = await importar(svc, [linea('2026-09-01', 8939.38, 'ASA CANCUN')]);
    expect(r.conciliados).toBe(0);
    expect(r.sin_candidato).toBe(1);
    expect(r.detalle[0].motivo).toBe(
      'Ningún gasto bancario sin conciliar de $8,939.38 MXN entre 2026-08-29 y 2026-09-04. El gasto en USD de $422.86 USD daría T.C. 21.14 · oficial 17.01 (+24.3 %): fuera de ±2 %, no se liga.',
    );
    expect(db.gasto[0].conciliado).toBe(false);
  });

  it('ASA I $14,197.17 + las bujías con el oficial del 24-sep (17.4691) ⇒ NO liga (+2.3 %)', async () => {
    const db = mundo({
      gasto: [gastoUsd('bujias', 794.61, '2026-09-24', { notas: BUJIAS })],
    });
    const { svc } = armar(db);
    const r = await importar(svc, [
      linea('2026-09-24', 14197.17, 'ASA CANCUN I\\CARR CANC'),
    ]);
    expect(r.conciliados).toBe(0);
    expect(r.detalle[0].motivo).toContain(
      '(+2.3 %): fuera de ±2 %, no se liga.',
    );
  });

  it('el gasto GAS en pesos EXACTO gana en el paso 1 (MONTO_EXACTO; pasos 1–2 de siempre)', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
        gastoMxn('46fa1d14', 8939.38, '2026-09-01', { lugar: 'ASA Cancún' }),
      ],
    });
    const { svc } = armar(db);
    const r = await importar(svc, [linea('2026-09-01', 8939.38, 'ASA CANCUN')]);
    expect(r.por_criterio.MONTO_EXACTO).toBe(1);
    expect(db.movimiento_bancario[0].gasto_id).toBe('46fa1d14');
    expect(db.gasto.find((g) => g.id === 'tubo')?.conciliado).toBe(false);
  });

  it('RECÍPROCO: dos cargos AIRCRAFT CERCA del MISMO gasto ⇒ los dos AMBIGUO (ninguno se liga)', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db);
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      linea('2026-09-03', 7250, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.conciliados).toBe(0);
    expect(r.ambiguos).toBe(2);
    expect(r.detalle.map((d) => d.motivo)).toEqual([
      'El gasto en USD de $422.86 USD también cuadra con el cargo del 03 sep de $7,250.00 («AIRCRAFT SPRUCE AND SP»): vincúlalo a mano.',
      'El gasto en USD de $422.86 USD también cuadra con el cargo del 01 sep de $7,214.14 («AIRCRAFT SPRUCE AND SP»): vincúlalo a mano.',
    ]);
  });

  it('un error en la lectura recíproca ⇒ ERROR (el cruce no se intenta)', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db, {
      fake: {
        antes: (op) =>
          op.tabla === 'movimiento_bancario' &&
          op.op === 'select' &&
          op.filtros.some(([f, c]) => f === 'neq' && c === 'id')
            ? { message: 'timeout' }
            : undefined,
      },
    });
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.errores).toBe(1);
    expect(r.detalle[0].motivo).toBe(TEXTO_CRUCE_USD_RECIPROCO_ERROR);
    expect(db.movimiento_bancario[0].gasto_id ?? null).toBeNull();
  });

  it('si el T.C. oficial no se puede leer ⇒ ERROR con su texto (no liga)', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db, { tc: tipoCambioFalso('falla') });
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.errores).toBe(1);
    expect(r.detalle[0].motivo).toBe(TEXTO_CRUCE_USD_SIN_LECTURA_TC);
  });

  it('25 o más gastos USD en banda ⇒ AMBIGUO (demasiados para decidir solo)', async () => {
    const db = mundo({
      gasto: Array.from({ length: 25 }, (_, i) =>
        gastoUsd(`u${i}`, 400 + i, '2026-09-01', { notas: TUBO }),
      ),
    });
    const { svc } = armar(db);
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.ambiguos).toBe(1);
    expect(r.detalle[0].motivo).toBe(TEXTO_CRUCE_USD_TRUNCADO);
  });

  it.each([
    ['sin TipoCambioService', null],
    ['sin dato del día', tipoCambioFalso('vacio')],
  ])('%s ⇒ AMBIGUO «No hay T.C. oficial del …»', async (_n, tc) => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
    });
    const { svc } = armar(db, { tc });
    const r = await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    expect(r.ambiguos).toBe(1);
    expect(r.detalle[0].motivo).toBe(
      'No hay T.C. oficial del 01 sep para comprobar el gasto en USD que podría ser este cargo: vincúlalo a mano.',
    );
  });

  it('solo la importación descarga el T.C. que falte; «Cruzar pendientes» solo lee la tabla', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: BUJIAS })],
    });
    const { svc, tc } = armar(db);
    await importar(svc, [
      linea('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
    ]);
    const llamadas = (tc as unknown as { oficialesPorDias: jest.Mock })
      .oficialesPorDias.mock.calls as Array<
      [string[], { descargar?: boolean }]
    >;
    expect(llamadas.length).toBeGreaterThan(0);
    expect(llamadas.every(([, o]) => o.descargar === true)).toBe(true);
    llamadas.length = 0;
    (
      tc as unknown as { oficialesPorDias: jest.Mock }
    ).oficialesPorDias.mockClear();
    await svc.autoMatchPendientes(
      { cuenta_bancaria_id: COMB, desde: '2026-08-01', hasta: '2026-09-30' },
      USER,
    );
    const reCruce = (tc as unknown as { oficialesPorDias: jest.Mock })
      .oficialesPorDias.mock.calls as Array<
      [string[], { descargar?: boolean }]
    >;
    expect(reCruce.length).toBeGreaterThan(0);
    expect(reCruce.every(([, o]) => o.descargar === false)).toBe(true);
  });

  it('camino inverso diferido: un gasto USD capturado después NO se cruza solo contra un cargo en pesos (+0.3 %)', async () => {
    const db = mundo({
      gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
      movimiento_bancario: [
        mov('aircraft', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.intentarCruzarGasto('tubo', USER);
    expect(r.ligado).toBe(false);
    expect(db.movimiento_bancario[0].gasto_id ?? null).toBeNull();
  });
});

describe('GET movimientos — motivo de los pendientes con la regla USD', () => {
  // Sintético (como en la especificación): las bujías DENTRO de la ventana
  // de ±3 días del cargo de $14,431.18 (en prod son 5 días: va a mano).
  const pendientes = () =>
    mundo({
      gasto: [
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
        gastoUsd('bujias', 794.61, '2026-09-28', { notas: BUJIAS }),
      ],
      movimiento_bancario: [
        mov('m-cruzable', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
        mov('m-contradice', '2026-09-29', 14431.18, 'AIRCRAFT SPRUCE AND SP'),
        mov('m-lejos', '2026-09-02', 8939.38, 'ASA CANCUN'),
        mov('m-nada', '2026-09-15', 99.99, 'OXXO'),
      ],
    });

  it('SE_PUEDE_CRUZAR / AMBIGUO / SIN_CANDIDATOS con su motivo_detalle', async () => {
    const { svc } = armar(pendientes());
    const { data } = await svc.list({ limit: 50, offset: 0 });
    const por = Object.fromEntries(data.map((m) => [m.id as string, m]));
    expect(por['m-cruzable']).toMatchObject({
      motivo_pendiente: 'SE_PUEDE_CRUZAR',
      candidatos_n: 1,
      motivo_detalle:
        'El gasto en USD de $422.86 USD cuadra con el T.C. oficial (T.C. 17.06 · oficial 17.01 (+0.3 %)) y la descripción del banco lo confirma: el cruce automático todavía no corre sobre este cargo. Pulsa «Cruzar pendientes» (o vincúlalo tú desde el menú).',
    });
    expect(por['m-contradice']).toMatchObject({
      motivo_pendiente: 'AMBIGUO',
      candidatos_n: 1,
      motivo_detalle:
        'El gasto en USD de $794.61 USD cuadra con el T.C. oficial (T.C. 18.16 · oficial 17.90 (+1.5 %)), pero la descripción del banco («AIRCRAFT SPRUCE AND SP») no coincide con el gasto: vincúlalo a mano si de verdad es ese.',
    });
    expect(por['m-lejos']).toMatchObject({
      motivo_pendiente: 'SIN_CANDIDATOS',
      motivo_detalle:
        'El gasto en USD de $422.86 USD daría T.C. 21.14 · oficial 17.01 (+24.3 %): fuera de ±2 %, no se liga.',
    });
    expect(por['m-nada'].motivo_pendiente).toBe('SIN_CANDIDATOS');
    expect(por['m-nada']).not.toHaveProperty('motivo_detalle');
  });

  it('si la lectura de oficiales falla, esos cargos quedan SIN anotar (jamás un «sin candidato» falso)', async () => {
    const { svc } = armar(pendientes(), { tc: tipoCambioFalso('falla') });
    const { data } = await svc.list({ limit: 50, offset: 0 });
    for (const m of data) {
      expect(m).not.toHaveProperty('motivo_pendiente');
      expect(m).not.toHaveProperty('motivo_detalle');
    }
  });
});

describe('GET movimientos/:id/gastos-candidatos — los USD en cuentas en pesos', () => {
  const MXN_NO_CUADRAN = Array.from({ length: 220 }, (_, i) =>
    gastoMxn(`mxn-${String(i).padStart(3, '0')}`, 100 + i, '2026-09-02', {
      medio_pago: 'TARJETA_CORP',
    }),
  );

  it('caso real «220 + tubo»: el tubo CERCA va en la posición 0 y la raíz trae el oficial', async () => {
    const db = mundo({
      gasto: [
        ...MXN_NO_CUADRAN,
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
      ],
      movimiento_bancario: [
        mov('aircraft', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.gastosCandidatosDeMovimiento('aircraft', {});
    expect(r.tc_oficial).toEqual({
      tc: 17.0077,
      fecha_dato: '2026-09-01',
      fuente: 'open.er-api',
    });
    expect(r.candidatos[0]).toMatchObject({
      id: 'tubo',
      cruzado: true,
      tc_implicito: 17.060351,
      tc_cruce: {
        nivel: 'CERCA',
        desvio_pct: 0.3,
        fuera_de_lugar: false,
        texto: 'T.C. 17.06 · oficial 17.01 (+0.3 %)',
      },
    });
    expect(r.candidatos).toHaveLength(100);
  });

  it('búsquedas: «422.86», «7214.14» y «spruce» encuentran el tubo; sin oficial, «7214.14» no y «422.86» sí', async () => {
    const db = () =>
      mundo({
        gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
        movimiento_bancario: [
          mov('aircraft', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
        ],
      });
    const con = armar(db()).svc;
    for (const q of ['422.86', '7214.14', 'spruce']) {
      const r = await con.gastosCandidatosDeMovimiento('aircraft', { q });
      expect(r.candidatos.map((c) => c.id)).toEqual(['tubo']);
    }
    const sin = armar(db(), { tc: tipoCambioFalso('vacio') }).svc;
    const a = await sin.gastosCandidatosDeMovimiento('aircraft', {
      q: '7214.14',
    });
    expect(a.candidatos.map((c) => c.id)).toEqual([]);
    expect(a.tc_oficial).toBeNull();
    const b = await sin.gastosCandidatosDeMovimiento('aircraft', {
      q: '422.86',
    });
    expect(b.candidatos[0]).toMatchObject({
      id: 'tubo',
      tc_cruce: { nivel: 'SIN_OFICIAL' },
    });
  });

  it('lectura del oficial FALLIDA (≠ sin dato): texto propio, `lectura_fallida` y la raíz lo dice', async () => {
    const db = () =>
      mundo({
        gasto: [gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO })],
        movimiento_bancario: [mov('asa', '2026-09-01', 8939.38, 'ASA CANCUN')],
      });
    // Revisión del lote 2 (14-oct-2026): con la lectura caída, el tubo del
    // caso Aircraft Spruce (+24.3 % contra el oficial real) ya no sale como
    // «sin T.C. oficial del día» (afirmaba que no había dato).
    const falla = await armar(db(), {
      tc: tipoCambioFalso('falla'),
    }).svc.gastosCandidatosDeMovimiento('asa', {});
    expect(falla.tc_oficial).toBeNull();
    expect(falla.tc_oficial_lectura_fallida).toBe(true);
    expect(falla.candidatos[0]).toMatchObject({
      id: 'tubo',
      cruzado: true,
      tc_cruce: {
        nivel: 'SIN_OFICIAL',
        lectura_fallida: true,
        fuera_de_lugar: false,
        texto: 'T.C. 21.14 · no se pudo leer el T.C. oficial del día',
      },
    });
    expect(falla.candidatos[0].tc_cruce?.titulo).toBe(
      'T.C. exacto 21.140283 (pesos del cargo ÷ dólares del gasto) · no se pudo leer el T.C. oficial del día del cargo: no se comprobó; vuelve a abrir «Vincular gasto» para compararlo',
    );
    // Sin dato del día (lectura buena): el texto de siempre y SIN las marcas.
    const vacio = await armar(db(), {
      tc: tipoCambioFalso('vacio'),
    }).svc.gastosCandidatosDeMovimiento('asa', {});
    expect(vacio).not.toHaveProperty('tc_oficial_lectura_fallida');
    expect(vacio.candidatos[0].tc_cruce).toMatchObject({
      nivel: 'SIN_OFICIAL',
      texto: 'T.C. 21.14 · sin T.C. oficial del día',
    });
    expect(vacio.candidatos[0].tc_cruce).not.toHaveProperty('lectura_fallida');
    // Con oficial: tampoco viaja la marca.
    const con = await armar(db()).svc.gastosCandidatosDeMovimiento('asa', {});
    expect(con).not.toHaveProperty('tc_oficial_lectura_fallida');
    expect(con.candidatos[0].tc_cruce).toMatchObject({ nivel: 'LEJOS' });
  });

  it('en «ASA CANCUN» $8,939.38 el tubo sale LEJOS, último de los bancarios', async () => {
    const db = mundo({
      gasto: [
        gastoMxn('mxn-1', 500, '2026-09-02'),
        gastoMxn('mxn-2', 600, '2026-09-03'),
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
      ],
      movimiento_bancario: [mov('asa', '2026-09-01', 8939.38, 'ASA CANCUN')],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('asa', {});
    const ids = r.candidatos.map((c) => c.id);
    expect(ids[ids.length - 1]).toBe('tubo');
    expect(r.candidatos[ids.length - 1].tc_cruce).toMatchObject({
      nivel: 'LEJOS',
      fuera_de_lugar: true,
    });
  });

  it('los cruzados siguen SOLO bancarios con incluir_no_bancarios', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('usd-efectivo', 422.86, '2026-09-01', {
          notas: TUBO,
          medio_pago: 'EFECTIVO',
        }),
      ],
      movimiento_bancario: [
        mov('aircraft', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      ],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('aircraft', {
      incluir_no_bancarios: true,
    });
    expect(r.candidatos.map((c) => c.id)).not.toContain('usd-efectivo');
  });

  it('injerto #8 — con el tubo aún ligado a ASA: «422.86» en AIRCRAFT ⇒ sin candidatos y YA_CONCILIADO con su cargo', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('tubo', 422.86, '2026-09-01', {
          notas: TUBO,
          conciliado: true,
          tc_gasto: 21.1403,
        }),
      ],
      movimiento_bancario: [
        mov('e5724490', '2026-09-01', 8939.38, 'ASA CANCUN', {
          conciliado: true,
          gasto_id: 'tubo',
        }),
        mov('ad07e93f', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      ],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('ad07e93f', {
      q: '422.86',
    });
    expect(r.candidatos).toEqual([]);
    expect(r.excluidos).toEqual([
      {
        motivo: 'YA_CONCILIADO',
        n: 1,
        gastos: [
          expect.objectContaining({
            id: 'tubo',
            conciliado_con: [
              {
                movimiento_id: 'e5724490',
                fecha: '2026-09-01',
                monto: 8939.38,
                moneda: 'MXN',
                cuenta: 'COMBUSTIBLE',
              },
            ],
          }),
        ],
      },
    ]);
  });
});

/** Las 2 ligas equivocadas tal como estaban ANTES de la corrección del 13-oct. */
function ligasAntes(extra: Partial<Tablas> = {}): Tablas {
  return mundo({
    gasto: [
      gastoUsd('2d37d95e', 422.86, '2026-09-01', {
        notas: TUBO,
        conciliado: true,
        tc_gasto: 21.1403,
      }),
      gastoUsd('340c3dc6', 794.61, '2026-09-24', {
        notas: BUJIAS,
        conciliado: true,
        tc_gasto: 17.86684,
      }),
      gastoUsd('913a7d19', 722.9, '2026-08-07', {
        notas: 'Aircraft Spruce 2 llantas 6.00-6',
        conciliado: true,
        tc_gasto: 17.22436,
      }),
    ],
    movimiento_bancario: [
      mov('e5724490', '2026-09-01', 8939.38, 'ASA CANCUN', {
        conciliado: true,
        gasto_id: '2d37d95e',
      }),
      mov('613ad49a', '2026-09-24', 14197.17, 'ASA CANCUN I\\CARR CANC', {
        conciliado: true,
        gasto_id: '340c3dc6',
      }),
      mov('bf543597', '2026-08-07', 12451.49, 'AIRCRAFT SPRUCE AND SP', {
        cuenta_bancaria_id: GG,
        conciliado: true,
        gasto_id: '913a7d19',
      }),
    ],
    ...extra,
  });
}

describe('GET movimientos — tc_cruce en las filas con UNA parte cruzada', () => {
  it('fuera_de_lugar true para 8,939.38 ↔ tubo y false para 12,451.49 ↔ 722.90', async () => {
    const { svc } = armar(ligasAntes());
    const { data } = await svc.list({ limit: 50, offset: 0 });
    const por = Object.fromEntries(data.map((m) => [m.id as string, m]));
    expect(por.e5724490.tc_cruce).toMatchObject({
      fuera_de_lugar: true,
      texto: 'T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial',
    });
    expect(por.bf543597.tc_cruce).toMatchObject({
      fuera_de_lugar: false,
      texto: 'T.C. 17.22 · oficial 17.29 (−0.4 %)',
      tc_oficial_fuente: 'BCE (frankfurter)',
    });
  });

  it('si el T.C. oficial no se puede leer, NINGUNA fila trae tc_cruce (y lo demás sale igual)', async () => {
    const { svc } = armar(ligasAntes(), { tc: tipoCambioFalso('falla') });
    const { data } = await svc.list({ limit: 50, offset: 0 });
    expect(data).toHaveLength(3);
    for (const m of data) expect(m).not.toHaveProperty('tc_cruce');
    expect(data.every((m) => Array.isArray(m.gastos))).toBe(true);
  });
});

describe('«Sugerir con IA» — los cruzados llevan tc_cruce y los LEJOS no se mandan', () => {
  it('candidatos de la IA: el tubo CERCA con tc_cruce; el USD LEJOS fuera', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
        gastoUsd('lejos', 380, '2026-09-01', { notas: 'Otra compra' }),
      ],
      movimiento_bancario: [
        mov('aircraft', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      ],
    });
    const s = await armar(db).svc.sugerir('aircraft');
    expect(s.candidatos.map((c) => c.id)).toEqual(['tubo']);
    expect(s.candidatos[0].tc_cruce).toMatchObject({ nivel: 'CERCA' });
  });

  it('con la LECTURA del oficial fallida, ningún cruzado va a la IA (no se sabe cuáles quedan LEJOS)', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('tubo', 422.86, '2026-09-01', { notas: TUBO }),
        gastoMxn('mxn-asa', 8939.38, '2026-09-01', {
          medio_pago: 'TARJETA_CORP',
        }),
      ],
      movimiento_bancario: [mov('asa', '2026-09-01', 8939.38, 'ASA CANCUN')],
    });
    const s = await armar(db, { tc: tipoCambioFalso('falla') }).svc.sugerir(
      'asa',
    );
    // El gasto en pesos de la cuenta sí; el tubo (+24.3 % real) no.
    expect(s.candidatos.map((c) => c.id)).toEqual(['mxn-asa']);
  });
});

describe('ligasUsdTcFueraDeLugar — el aviso del pre-cierre', () => {
  it('septiembre con las ligas de ANTES: 2 ligas en orden (tubo, bujías) con sus textos', async () => {
    const r = await armar(ligasAntes()).svc.ligasUsdTcFueraDeLugar(
      '2026-09-01',
      '2026-09-30',
    );
    expect(r?.sin_verificar).toBe(0);
    expect(r?.ligas.map((l) => [l.gasto_id, l.movimiento_id])).toEqual([
      ['2d37d95e', 'e5724490'],
      ['340c3dc6', '613ad49a'],
    ]);
    expect(r?.ligas.map((l) => l.texto)).toEqual([
      '$422.86 USD · Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00… (01 sep) ↔ cargo «ASA CANCUN» de $8,939.38 del 01 sep (COMBUSTIBLE): T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial',
      '$794.61 USD · 1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 1… (24 sep) ↔ cargo «ASA CANCUN I\\CARR CANC» de $14,197.17 del 24 sep (COMBUSTIBLE): T.C. 17.87 · oficial 17.47 (+2.3 %): lejos del oficial',
    ]);
    expect(r?.ligas[0]).toMatchObject({
      fecha_gasto: '2026-09-01',
      monto_usd: 422.86,
      tc_gasto: 21.1403,
      categoria: 'REFACCION',
      cuenta_bancaria_id: COMB,
      cuenta: 'COMBUSTIBLE',
      descripcion_cargo: 'ASA CANCUN',
    });
  });

  it('agosto (la liga correcta de las llantas) y octubre ⇒ 0', async () => {
    const { svc } = armar(ligasAntes());
    expect(
      await svc.ligasUsdTcFueraDeLugar('2026-08-01', '2026-08-31'),
    ).toEqual({
      ligas: [],
      sin_verificar: 0,
    });
    expect(
      await svc.ligasUsdTcFueraDeLugar('2026-10-01', '2026-10-31'),
    ).toEqual({
      ligas: [],
      sin_verificar: 0,
    });
  });

  it('DESPUÉS de la corrección del 13-oct (ligas a AIRCRAFT) ⇒ 0', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('2d37d95e', 422.86, '2026-09-01', {
          notas: TUBO,
          conciliado: true,
        }),
        gastoUsd('340c3dc6', 794.61, '2026-09-24', {
          notas: BUJIAS,
          conciliado: true,
        }),
      ],
      movimiento_bancario: [
        mov('ad07e93f', '2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP', {
          conciliado: true,
          gasto_id: '2d37d95e',
        }),
        mov('5b06e82e', '2026-09-29', 14431.18, 'AIRCRAFT SPRUCE AND SP', {
          conciliado: true,
          gasto_id: '340c3dc6',
        }),
      ],
    });
    expect(
      await armar(db).svc.ligasUsdTcFueraDeLugar('2026-09-01', '2026-09-30'),
    ).toEqual({ ligas: [], sin_verificar: 0 });
  });

  it('sin la sonda de partes o sin TipoCambioService ⇒ null; la lectura truncada ⇒ null', async () => {
    const sinPartes = armar(ligasAntes(), {
      fake: { ausentes: { movimiento_bancario: ['gastos_n'] } },
    });
    expect(
      await sinPartes.svc.ligasUsdTcFueraDeLugar('2026-09-01', '2026-09-30'),
    ).toBeNull();
    const sinTc = armar(ligasAntes(), { tc: null });
    expect(
      await sinTc.svc.ligasUsdTcFueraDeLugar('2026-09-01', '2026-09-30'),
    ).toBeNull();
    const muchos = mundo({
      gasto: Array.from({ length: 5000 }, (_, i) =>
        gastoUsd(`g${String(i).padStart(4, '0')}`, 10, '2026-09-10', {
          conciliado: true,
        }),
      ),
    });
    expect(
      await armar(muchos).svc.ligasUsdTcFueraDeLugar(
        '2026-09-01',
        '2026-09-30',
      ),
    ).toBeNull();
  });

  it('una liga FUERA de banda se reporta; una en banda SIN oficial cuenta en sin_verificar', async () => {
    const db = mundo({
      gasto: [
        gastoUsd('g325', 325, '2026-10-12', {
          notas: 'Bruces Custom Covers',
          conciliado: true,
        }),
        gastoUsd('g-junio', 300, '2026-10-02', {
          notas: 'Compra de junio',
          conciliado: true,
        }),
      ],
      movimiento_bancario: [
        mov('c-fuera', '2026-10-12', 3740.63, 'AIRCRAFT SPRUCE AND SP', {
          conciliado: true,
          gasto_id: 'g325',
        }),
        // Cargo de junio (la tabla empieza el 1-jul): sin oficial del día.
        mov('c-junio', '2026-06-20', 5400, 'GARMIN', {
          conciliado: true,
          gasto_id: 'g-junio',
        }),
      ],
    });
    const r = await armar(db).svc.ligasUsdTcFueraDeLugar(
      '2026-10-01',
      '2026-10-31',
    );
    expect(r?.sin_verificar).toBe(1);
    expect(r?.ligas).toHaveLength(1);
    expect(r?.ligas[0].tc_cruce).toMatchObject({
      en_banda: false,
      fuera_de_lugar: true,
      texto: 'T.C. 11.51 · oficial 18.41 (−37.5 %): fuera de la banda 15–25',
    });
  });
});
