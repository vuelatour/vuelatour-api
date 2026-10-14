import {
  DESCARGAS_TC_MAX,
  FUENTE_DIARIA,
  FUENTE_HISTORICA,
  TipoCambioService,
  tcOficialVigente,
  VENTANA_RESPALDO_TC_DIAS,
} from './tipo-cambio.service';
import {
  fakePostgrest,
  type OpcionesFake,
  type Row,
} from '../conciliacion/conciliacion-postgrest.fixture-spec';

/**
 * T.C. OFICIAL DE VARIOS DÍAS (13-oct-2026, invariante 70: cruce de gastos
 * en dólares contra cargos en pesos). Fixture con las filas REALES que
 * citan las ligas de prod: la tabla empieza el 2026-07-01, el 28-ago usa el
 * dato del 21-ago (justo en el borde de 7 días), el 07-ago el del 04-ago
 * (BCE) y el 27-jul el del 24-jul.
 */
type FilaTc = { fecha: string; tc: number; fuente: string };
const FILAS: FilaTc[] = [
  { fecha: '2026-07-01', tc: 18.8601, fuente: FUENTE_HISTORICA },
  { fecha: '2026-07-24', tc: 17.4803, fuente: FUENTE_HISTORICA },
  { fecha: '2026-08-04', tc: 17.2881, fuente: FUENTE_HISTORICA },
  { fecha: '2026-08-21', tc: 16.898, fuente: FUENTE_DIARIA },
  { fecha: '2026-08-27', tc: 0, fuente: FUENTE_DIARIA }, // inválida: se ignora
  { fecha: '2026-09-01', tc: 17.0077, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-24', tc: 17.4691, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-29', tc: 17.8992, fuente: FUENTE_DIARIA },
  { fecha: '2026-10-12', tc: 18.4067, fuente: FUENTE_DIARIA },
];

function armar(opts: OpcionesFake = {}, filas: FilaTc[] = FILAS) {
  const db = { tipo_cambio_oficial: filas.map((f): Row => ({ ...f })) };
  const fake = fakePostgrest(db, opts);
  return { svc: new TipoCambioService(fake.supabase), db, ...fake };
}

afterEach(() => jest.restoreAllMocks());

describe('oficialesPorDias — UNA lectura, respaldo de 7 días, sin descargar', () => {
  it('días reales: borde de 7 días, fuente legible y día sin tabla fuera del mapa', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const { svc, log } = armar();
    const r = await svc.oficialesPorDias([
      '2026-08-28',
      '2026-08-07',
      '2026-07-27',
      '2026-06-20',
      '2026-08-28',
      'no-es-fecha',
    ]);
    expect(r).not.toBeNull();
    expect(Object.fromEntries(r!)).toEqual({
      '2026-08-28': {
        tc: 16.898,
        fecha_dato: '2026-08-21',
        fuente: 'open.er-api',
      },
      '2026-08-07': {
        tc: 17.2881,
        fecha_dato: '2026-08-04',
        fuente: 'BCE (frankfurter)',
      },
      '2026-07-27': {
        tc: 17.4803,
        fecha_dato: '2026-07-24',
        fuente: 'BCE (frankfurter)',
      },
    });
    // UNA lectura (fecha desc, desde el mínimo − 7 hasta el máximo).
    const lecturas = log.filter((o) => o.tabla === 'tipo_cambio_oficial');
    expect(lecturas).toHaveLength(1);
    expect(lecturas[0].filtros).toEqual(
      expect.arrayContaining([
        ['gte', 'fecha', '2026-06-13'],
        ['lte', 'fecha', '2026-08-28'],
      ]),
    );
    expect(lecturas[0].orden).toEqual([['fecha', false]]);
    expect(fetch).not.toHaveBeenCalled();
    expect(VENTANA_RESPALDO_TC_DIAS).toBe(7);
  });

  it('un error de lectura ⇒ null (jamás «sin dato»)', async () => {
    const { svc } = armar({
      fallos: { 'tipo_cambio_oficial:select': { message: 'timeout' } },
    });
    expect(await svc.oficialesPorDias(['2026-09-01'])).toBeNull();
  });

  it('sin días válidos ⇒ mapa vacío sin consultar', async () => {
    const { svc, log } = armar();
    expect((await svc.oficialesPorDias([]))?.size).toBe(0);
    expect(log).toEqual([]);
  });

  it('días a más de 900 de distancia ⇒ una lectura por tramo', async () => {
    const { svc, log } = armar();
    const r = await svc.oficialesPorDias(['2024-01-10', '2026-09-01']);
    expect(r?.get('2026-09-01')?.tc).toBe(17.0077);
    expect(r?.has('2024-01-10')).toBe(false);
    expect(log.filter((o) => o.tabla === 'tipo_cambio_oficial')).toHaveLength(
      2,
    );
  });
});

describe('oficialesPorDias({descargar: true}) — ≤ 5 días faltantes, los más recientes primero', () => {
  it('baja SOLO los que faltan, hasta DESCARGAS_TC_MAX, del más reciente al más viejo', async () => {
    const pedidos: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation((url) => {
      const u =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const fecha = /\/v1\/(\d{4}-\d{2}-\d{2})\?/.exec(u)?.[1] ?? '';
      pedidos.push(fecha);
      return Promise.resolve(
        new Response(JSON.stringify({ date: fecha, rates: { MXN: 18.5 } }), {
          status: 200,
        }),
      );
    });
    const { svc } = armar();
    const dias = [
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
      '2026-06-16',
      '2026-09-01',
    ];
    const r = await svc.oficialesPorDias(dias, { descargar: true });
    expect(DESCARGAS_TC_MAX).toBe(5);
    expect(pedidos).toEqual([
      '2026-06-16',
      '2026-06-15',
      '2026-06-14',
      '2026-06-13',
      '2026-06-12',
    ]);
    expect(r?.get('2026-06-16')).toEqual({
      tc: 18.5,
      fecha_dato: '2026-06-16',
      fuente: 'BCE (frankfurter)',
    });
    expect(r?.has('2026-06-10')).toBe(false);
    expect(r?.get('2026-09-01')?.tc).toBe(17.0077);
  });
});

describe('tcOficialVigente — el mismo resultado que oficialDetallePara', () => {
  it('sobre las mismas filas (días pasados con dato; sin red)', async () => {
    // `oficialDetallePara` toma la fila más reciente de la ventana aunque
    // sea inválida (y entonces descarga): la comparación es con filas
    // válidas, que es lo que garantiza la BD.
    const validas = FILAS.filter((f) => Number(f.tc) > 0);
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('sin red en el spec'));
    const { svc } = armar({}, validas);
    const desc = [...validas].sort((a, b) =>
      String(a.fecha) < String(b.fecha) ? 1 : -1,
    );
    for (const dia of [
      '2026-08-28',
      '2026-08-07',
      '2026-07-27',
      '2026-09-30',
    ]) {
      const d = await svc.oficialDetallePara(dia);
      const v = tcOficialVigente(desc, dia);
      expect(v).not.toBeNull();
      expect(v?.tc).toBe(d?.tc);
      expect(v?.fecha_dato).toBe(d?.fecha_dato);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignora filas inválidas, fuera de la ventana o posteriores al día', () => {
    expect(
      tcOficialVigente(
        [
          { fecha: '2026-08-29', tc: 17 },
          { fecha: '2026-08-27', tc: 0 },
          { fecha: '2026-08-20', tc: 16.9 },
        ],
        '2026-08-28',
      ),
    ).toBeNull();
    expect(
      tcOficialVigente([{ fecha: '2026-08-21', tc: 'x' }], '2026-08-28'),
    ).toBeNull();
    expect(tcOficialVigente([], 'no-es-fecha')).toBeNull();
  });
});
