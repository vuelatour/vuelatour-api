import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import {
  COLUMNAS_AUSENTES_COBROS,
  fakeCobrosParciales,
  type OpcionesCobrosParciales,
  type Row,
  type Tablas,
} from './cobros-parciales.fixture-spec';

/**
 * UN COBRO, VARIOS ABONOS — AUTO-CRUCE, ANTI DOBLE CONTEO Y PAYWISE
 * (14-oct-2026, API 0.0.78, invariante 77, D11 / D12 / D6). Casos reales:
 * las camionetas de Beh Kay (#315: $3,400 pagados con DOS SPEI de $1,700) y
 * el lote de $69,000 = $18,001 (lo que le faltaba al cobro de $30,000 con
 * $11,999 previos) + $50,999. Contra la BD falsa que emula la migración
 * 20261014000003 (y la «BD vieja» 20261012000002), se congela:
 * - el auto-cruce («Cruzar pendientes» / importación) en UN universo: el
 *   segundo SPEI se liga SOLO por el FALTANTE exacto (criterio FALTANTE);
 *   con un cobro libre de otro cliente por el mismo monto ⇒ AMBIGUO, o el
 *   nombre del ordenante desempata (DESCRIPCION); nunca crea un parcial; un
 *   parcial «de un solo abono» (comisión, método Paywise) no entra; sin la
 *   sonda, todo como el 0.0.77;
 * - `cobrosExactosLibresDeAbono` (freno del auto al ligar un INGRESO y del
 *   riesgo de «Omitir») cuenta el faltante de los parciales;
 * - «Por conciliar» (`contextoAbonos` / `abonosPendientes`) dice lo MISMO
 *   que el auto y la IA no recibe parciales (y no propone «otro ingreso»
 *   para el dinero que le falta a uno);
 * - Paywise con abonos como los de prod (sin bruto ni comisión): NETO liga
 *   sin escribir, la importación infiere la comisión por BRUTO, la pasarela
 *   jamás completa un parcial y los 409 llegan a `errores[]` en es-MX.
 */

const USER = 'u-oficina';
const CTA = 'cta-mxn';
const CTA_PW = 'cta-paywise';

const abono = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-16',
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
  created_at: '2026-09-17T15:00:00Z',
  cobros_n: 0,
  updated_by: null,
  ...extra,
});

/** Abono YA ligado a UN cobro (espejo + su parte = |abono|), sin triggers. */
const ligado = (
  db: Tablas,
  id: string,
  monto: number,
  cobroId: string,
  extra: Row = {},
) => {
  db.movimiento_bancario.push(
    abono(id, monto, {
      fecha: '2026-09-15',
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

const vuelo = (folio: number, cliente: string): Row => ({
  id: `v${folio}`,
  folio,
  fecha_vuelo: '2026-09-15T14:00:00Z',
  cliente_id: cliente,
  tc_usd_mxn: null,
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
      vuelo(315, 'k-behkay'),
      vuelo(332, 'k-behkay'),
      vuelo(277, 'k-villa'),
      vuelo(278, 'k-villa'),
      vuelo(293, 'k-villa'),
    ],
    vuelo_grupo: [],
    cobro_grupo: [],
    movimiento_bancario: [],
    movimiento_bancario_cobro: [],
    cobro_vuelo: [],
    conciliacion_clasificacion: [],
    tarjeta_corporativa: [],
    ingreso: [],
    ...extra,
  };
}

/**
 * #315 ($3,400) con el PRIMER SPEI de $1,700 ya ligado (m1, 15-sep) y el
 * SEGUNDO pendiente (m2, 16-sep).
 */
function behKay(extra: Partial<Tablas> = {}, m2: Row = {}): Tablas {
  const db = mundo({
    cobro_vuelo: [cobro('c315', 'v315', 3400)],
    ...extra,
  });
  ligado(db, 'm1', 1700, 'c315');
  db.movimiento_bancario.push(abono('m2', 1700, m2));
  return db;
}

const CONFIG_IA: Record<string, string> = {
  PYSERVICES_BASE_URL: 'http://py.test',
  INTERNAL_SHARED_TOKEN: 'tok',
};

function armar(
  db: Tablas,
  opts: OpcionesCobrosParciales & { config?: Record<string, string> } = {},
) {
  const f = fakeCobrosParciales(db, opts);
  const config = opts.config ?? {};
  const svc = new ConciliacionService(
    { get: (k: string) => config[k] ?? '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    f.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, log: f.log, escrituras: f.escrituras };
}

/** Con la migración de ingresos (ingreso_id / ingreso_anticipo_id existen). */
const CON_INGRESOS: OpcionesCobrosParciales = {
  ausentes: COLUMNAS_AUSENTES_COBROS.filter(
    (c) => c !== 'ingreso_id' && c !== 'ingreso_anticipo_id',
  ),
};

const partesDe = (db: Tablas, cobroId: string) =>
  db.movimiento_bancario_cobro
    .filter((p) => p.cobro_id === cobroId)
    .map((p) => [p.movimiento_id, p.monto_parte]);

/** El «Cruzar pendientes» de UN abono. */
async function cruzar(svc: ConciliacionService, movId: string) {
  const r = await svc.autoMatchPendientes({ movimiento_ids: [movId] }, USER);
  return { r, d: r.detalle.find((x) => x.movimiento_id === movId) };
}

/**
 * Acceso al freno anti doble conteo (privado; nombra `ingreso_anticipo_id`:
 * solo corre con la migración de ingresos, como en prod).
 */
function exactosLibres(
  svc: ConciliacionService,
  monto: number,
  fecha: string,
  pasarela = false,
): Promise<number | null> {
  return (
    svc as unknown as {
      cobrosExactosLibresDeAbono: (
        a: {
          monto: number;
          monto_bruto: number | null;
          descripcion: string | null;
          cuenta_bancaria_id: string;
        },
        f: string,
        m: string,
        p: boolean,
      ) => Promise<number | null>;
    }
  ).cobrosExactosLibresDeAbono(
    {
      monto,
      monto_bruto: null,
      descripcion: null,
      cuenta_bancaria_id: pasarela ? CTA_PW : CTA,
    },
    fecha,
    'MXN',
    pasarela,
  );
}

describe('Auto-cruce — UN universo con los PARCIALES por su FALTANTE (D11)', () => {
  it('2.º SPEI de Beh Kay ($1,700) ⇒ se liga solo al cobro #315 por FALTANTE y lo completa', async () => {
    const { svc, db } = armar(behKay());
    const { r, d } = await cruzar(svc, 'm2');
    expect(d).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'FALTANTE',
      cobro_id: 'c315',
      candidatos_n: 1,
    });
    expect(r.por_criterio).toEqual({ FALTANTE: 1 });
    expect(partesDe(db, 'c315')).toEqual([
      ['m1', 1700],
      ['m2', 1700],
    ]);
    expect(db.movimiento_bancario.find((m) => m.id === 'm2')).toMatchObject({
      conciliado: true,
      cobro_id: 'c315',
      cobros_n: 1,
    });
  });

  it('$69,000 = $18,001 + $50,999: el abono de $18,001 completa el cobro de $30,000 que ya tenía $11,999 (FALTANTE)', async () => {
    const db = mundo({ cobro_vuelo: [cobro('c278', 'v278', 30000)] });
    ligado(db, 'm-previo', 11999, 'c278');
    db.movimiento_bancario.push(abono('m-18001', 18001));
    const { svc } = armar(db);
    const { d } = await cruzar(svc, 'm-18001');
    expect(d).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'FALTANTE',
      cobro_id: 'c278',
    });
    expect(partesDe(db, 'c278')).toEqual([
      ['m-previo', 11999],
      ['m-18001', 18001],
    ]);
  });

  it('un cobro LIBRE de $1,700 de otro cliente empata con el faltante ⇒ AMBIGUO (nada escrito)', async () => {
    const { svc, escrituras } = armar(
      behKay({
        cobro_vuelo: [
          cobro('c315', 'v315', 3400),
          cobro('c-villa', 'v277', 1700),
        ],
      }),
    );
    const { d } = await cruzar(svc, 'm2');
    expect(d).toMatchObject({ resultado: 'AMBIGUO', candidatos_n: 2 });
    expect(d?.motivo).toBe(
      '2 cobros/sobres cuadran con este abono (uno por lo que le falta a un pago parcial): vincúlalo a mano.',
    );
    expect(escrituras()).toEqual([]);
  });

  it('el NOMBRE del ordenante desempata (DESCRIPCION): Beh Kay ⇒ el parcial; Villanueva ⇒ el libre (el parcial sigue parcial)', async () => {
    const dos = () => ({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400),
        cobro('c-villa', 'v277', 1700),
      ],
    });
    const a = armar(
      behKay(dos(), { descripcion: 'SPEI BEH KAY SA DE CV CAMIONETAS' }),
    );
    const ra = await cruzar(a.svc, 'm2');
    expect(ra.d).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'DESCRIPCION',
      cobro_id: 'c315',
      candidatos_n: 2,
    });

    const b = armar(behKay(dos(), { descripcion: 'SPEI VILLANUEVA PAGO' }));
    const rb = await cruzar(b.svc, 'm2');
    expect(rb.d).toMatchObject({
      resultado: 'CONCILIADO',
      criterio: 'DESCRIPCION',
      cobro_id: 'c-villa',
    });
    expect(partesDe(b.db, 'c315')).toEqual([['m1', 1700]]);
  });

  it('NUNCA crea un parcial: $1,000 contra el faltante de $1,700 o $1,700 contra un cobro libre de $3,400 ⇒ SIN_CANDIDATO', async () => {
    const a = armar(behKay({}, { monto: 1000 }));
    const ra = await cruzar(a.svc, 'm2');
    expect(ra.d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(ra.d?.motivo).toBe(
      'Ningún cobro bancario de $1,000.00 MXN entre 2026-09-13 y 2026-09-19.',
    );
    expect(a.escrituras()).toEqual([]);

    const b = armar(
      mundo({
        cobro_vuelo: [cobro('c400', 'v332', 3400)],
        movimiento_bancario: [abono('m-mitad', 1700)],
      }),
    );
    const rb = await cruzar(b.svc, 'm-mitad');
    expect(rb.d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(b.escrituras()).toEqual([]);
  });

  it('el monto COMPLETO de un cobro ya parcial ($3,400) no cuadra: «Ningún cobro bancario libre…»; un centavo de menos tampoco', async () => {
    const a = armar(behKay({}, { monto: 3400 }));
    const ra = await cruzar(a.svc, 'm2');
    expect(ra.d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(ra.d?.motivo).toBe(
      'Ningún cobro bancario libre de $3,400.00 MXN entre 2026-09-13 y 2026-09-19.',
    );
    const b = armar(behKay({}, { monto: 1699.99 }));
    const rb = await cruzar(b.svc, 'm2');
    expect(rb.d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(b.escrituras()).toEqual([]);
  });

  it('un parcial «de un solo abono» (comisión del link o método Paywise) NO entra: ni lo liga ni lo cuenta', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c-hsbc', 'v293', 5000, {
          metodo_cobro: 'HSBC_LINK',
          comision_banco_monto: 250,
        }),
        cobro('c-pw', 'v332', 3400, { metodo_cobro: 'PAYWISE' }),
      ],
    });
    // Ligas viejas (antes de la regla nueva): parciales que A ya no admitiría.
    ligado(db, 'm-hsbc-1', 2000, 'c-hsbc');
    ligado(db, 'm-pw-1', 1700, 'c-pw');
    db.movimiento_bancario.push(abono('m-hsbc-2', 2750), abono('m-pw-2', 1700));
    const { svc, escrituras } = armar(db, CON_INGRESOS);
    expect((await cruzar(svc, 'm-hsbc-2')).d).toMatchObject({
      resultado: 'SIN_CANDIDATO',
    });
    expect((await cruzar(svc, 'm-pw-2')).d).toMatchObject({
      resultado: 'SIN_CANDIDATO',
    });
    expect(escrituras()).toEqual([]);
    expect(await exactosLibres(svc, 2750, '2026-09-16')).toBe(0);
    expect(await exactosLibres(svc, 1700, '2026-09-16')).toBe(0);
  });

  it('un cobro CUBIERTO sigue ocupado: un 3.er abono de $100 no encuentra cobro', async () => {
    const db = behKay();
    ligado(db, 'm2b', 1700, 'c315', { fecha: '2026-09-16' });
    db.movimiento_bancario.push(abono('m3', 100));
    const { svc, escrituras } = armar(db);
    expect((await cruzar(svc, 'm3')).d).toMatchObject({
      resultado: 'SIN_CANDIDATO',
    });
    expect(escrituras()).toEqual([]);
  });

  it('SIN la migración 20261014000003 (sonda false): como el 0.0.77 — el 2.º SPEI no se cruza y nada se escribe', async () => {
    const { svc, escrituras, log } = armar(behKay(), { bdVieja: true });
    const { d } = await cruzar(svc, 'm2');
    expect(d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(d?.motivo).toBe(
      'Ningún cobro bancario de $1,700.00 MXN entre 2026-09-13 y 2026-09-19.',
    );
    expect(escrituras()).toEqual([]);
    // Sin la sonda no se lee la cobertura de la ventana (la consulta de
    // siempre: sin moneda ni método en el select del cobro).
    expect(
      log.some(
        (o) =>
          o.tabla === 'cobro_vuelo' &&
          o.op === 'select' &&
          o.sel.includes('metodo_cobro, comision_banco_monto, fecha_cobro'),
      ),
    ).toBe(false);
  });

  it('una lectura caída de los abonos de la ventana ⇒ ERROR (el abono queda pendiente, jamás «libre» a ciegas)', async () => {
    let n = 0;
    const { svc, escrituras } = armar(behKay(), {
      antes: (op) => {
        if (op.tabla === 'movimiento_bancario_cobro' && op.op === 'select') {
          n += 1;
          return {
            code: '57014',
            message: 'canceling statement due to timeout',
          };
        }
      },
    });
    const { d } = await cruzar(svc, 'm2');
    expect(n).toBeGreaterThan(0);
    expect(d).toMatchObject({ resultado: 'ERROR' });
    expect(d?.motivo).toMatch(/No se pudieron leer los abonos/);
    expect(escrituras()).toEqual([]);
  });
});

describe('Anti doble conteo — `cobrosExactosLibresDeAbono` cuenta el FALTANTE (D12)', () => {
  it('a 10 días del abono (fuera del auto, dentro de ±30): el parcial al que le falta EXACTO el abono cuenta; otra cifra no', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400, { fecha_cobro: '2026-09-06T17:00:00Z' }),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    const { svc } = armar(db, CON_INGRESOS);
    expect(await exactosLibres(svc, 1700, '2026-09-16')).toBe(1);
    expect(await exactosLibres(svc, 1700.5, '2026-09-16')).toBe(0);
    expect(await exactosLibres(svc, 3400, '2026-09-16')).toBe(0);
    // Un abono de la PASARELA no completa parciales.
    expect(await exactosLibres(svc, 1700, '2026-09-16', true)).toBe(0);
  });

  it('sin la sonda (BD vieja): el parcial está ocupado, como el 0.0.77', async () => {
    const db = mundo({ cobro_vuelo: [cobro('c315', 'v315', 3400)] });
    ligado(db, 'm1', 1700, 'c315');
    const { svc } = armar(db, { ...CON_INGRESOS, bdVieja: true });
    expect(await exactosLibres(svc, 1700, '2026-09-16')).toBe(0);
  });

  it('cobros sin abonos: lo de siempre (exacto y libre cuenta; ligado no)', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c-a', 'v332', 1700),
        cobro('c-b', 'v277', 1700),
        cobro('c-otro', 'v278', 900),
      ],
    });
    ligado(db, 'm-b', 1700, 'c-b');
    const { svc } = armar(db, CON_INGRESOS);
    expect(await exactosLibres(svc, 1700, '2026-09-16')).toBe(1);
  });

  it('el auto elige un INGRESO pero un PARCIAL espera exactamente ese dinero (a 10 días) ⇒ AMBIGUO, no liga el ingreso', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400, { fecha_cobro: '2026-09-06T17:00:00Z' }),
      ],
      ingreso: [
        {
          id: 'i-1',
          folio: 7,
          categoria: 'OTRO_INGRESO',
          fecha: '2026-09-16',
          monto: 1700,
          comision_monto: null,
          moneda: 'MXN',
          cuenta_bancaria_id: CTA,
          pagador: 'Alguien',
          descripcion: 'Renta',
          referencia: null,
          deleted_at: null,
        },
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    db.movimiento_bancario.push(abono('m2', 1700));
    const { svc, escrituras } = armar(db, CON_INGRESOS);
    const { d } = await cruzar(svc, 'm2');
    expect(d).toMatchObject({ resultado: 'AMBIGUO', candidatos_n: 2 });
    expect(d?.motivo).toMatch(/ingreso registrado y también con un cobro/);
    expect(escrituras()).toEqual([]);
  });
});

describe('«Por conciliar» (contextoAbonos) dice lo mismo que el auto; la IA no recibe parciales', () => {
  const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };

  it('el 2.º SPEI ⇒ SE_PUEDE_CRUZAR y 1 exacto (por el faltante); con un libre igual de otro cliente ⇒ AMBIGUO', async () => {
    const a = armar(behKay(), CON_INGRESOS);
    const ra = await a.svc.abonosPendientes(PERIODO);
    expect(ra.motivos_calculados).toBe(true);
    expect(ra.data.find((x) => x.id === 'm2')).toMatchObject({
      motivo_pendiente: 'SE_PUEDE_CRUZAR',
      candidatos_n: 1,
      exactos_manual: 1,
    });
    // La puente (universo) se leyó con la parte y el abono embebido
    // (cobertura), paginada por su llave COMPLETA (cobro_id, movimiento_id).
    const puente = a.log.filter(
      (o) => o.tabla === 'movimiento_bancario_cobro' && o.op === 'select',
    );
    expect(puente.length).toBeGreaterThan(0);
    for (const o of puente) {
      expect(o.sel).toContain('monto_parte');
      expect(o.sel).toContain('movimiento:movimiento_bancario!movimiento_id(');
      expect(o.orden).toEqual([
        ['cobro_id', true],
        ['movimiento_id', true],
      ]);
    }

    const b = armar(
      behKay({
        cobro_vuelo: [
          cobro('c315', 'v315', 3400),
          cobro('c-villa', 'v277', 1700),
        ],
      }),
      CON_INGRESOS,
    );
    const rb = await b.svc.abonosPendientes(PERIODO);
    expect(rb.data.find((x) => x.id === 'm2')).toMatchObject({
      motivo_pendiente: 'AMBIGUO',
      candidatos_n: 2,
      exactos_manual: 2,
    });
  });

  it('sin la sonda: el parcial está ocupado (SIN_CANDIDATOS, 0 exactos), como el 0.0.77', async () => {
    const { svc } = armar(behKay(), { ...CON_INGRESOS, bdVieja: true });
    const r = await svc.abonosPendientes(PERIODO);
    expect(r.data.find((x) => x.id === 'm2')).toMatchObject({
      motivo_pendiente: 'SIN_CANDIDATOS',
      exactos_manual: 0,
    });
  });

  it('la IA no recibe el parcial y su «registrar como otro ingreso» ⇒ REVISAR: a ese cobro le falta exactamente el abono', async () => {
    let enviados: string[] = [];
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((_u, init) => {
        const body = JSON.parse(String(init?.body as string)) as {
          abonos: Array<{ id: string; candidato_ids: string[] }>;
        };
        enviados = body.abonos.flatMap((x) => x.candidato_ids);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              modelo: 'claude',
              sugerencias: [
                {
                  movimiento_id: 'm2',
                  candidato_id: null,
                  accion: 'REGISTRAR_INGRESO',
                  confianza: 0.8,
                  razon: 'parece otro ingreso',
                  categoria_sugerida: 'OTRO_INGRESO',
                },
              ],
            }),
        } as unknown as Response);
      });
    try {
      // El cobro #315 (parcial) es de 10 días antes: el auto (±3) no lo ve
      // y el abono va a la IA.
      const db = mundo({
        cobro_vuelo: [
          cobro('c315', 'v315', 3400, { fecha_cobro: '2026-09-06T17:00:00Z' }),
          cobro('c-otro', 'v277', 2500, {
            fecha_cobro: '2026-09-10T17:00:00Z',
          }),
        ],
      });
      ligado(db, 'm1', 1700, 'c315', { fecha: '2026-09-06' });
      db.movimiento_bancario.push(abono('m2', 1700));
      const { svc, escrituras } = armar(db, {
        ...CON_INGRESOS,
        config: CONFIG_IA,
      });
      const r = await svc.sugerirAbonos({ movimiento_ids: ['m2'] }, USER);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(enviados).toEqual(['COBRO_VUELO:c-otro']);
      expect(r.propuestas[0]).toMatchObject({
        movimiento_id: 'm2',
        origen: 'IA',
        accion: 'REVISAR',
        candidato: null,
        confianza: 0,
      });
      expect(r.propuestas[0].motivo_sin_match).toBe(
        'Al cobro del vuelo #315 (pago parcial) le falta exactamente este monto: revísalo y vincula el abono a ese cobro',
      );
      expect(escrituras()).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('La IA y un parcial que empata con un cobro libre exacto', () => {
  it('«registrar como otro ingreso» con un cobro libre EXACTO (enviado a la IA) y un parcial al que le falta lo mismo ⇒ REVISAR (nunca LIGAR solo)', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            modelo: 'claude',
            sugerencias: [
              {
                movimiento_id: 'm2',
                candidato_id: null,
                accion: 'REGISTRAR_INGRESO',
                confianza: 0.8,
                razon: 'parece otro ingreso',
              },
            ],
          }),
      } as unknown as Response),
    );
    try {
      const db = mundo({
        cobro_vuelo: [
          cobro('c315', 'v315', 3400, { fecha_cobro: '2026-09-06T17:00:00Z' }),
          // Libre y exacto, pero BILLPOCKET (manual): el auto no lo ve.
          cobro('c-bp', 'v277', 1700, {
            metodo_cobro: 'BILLPOCKET',
            fecha_cobro: '2026-09-10T17:00:00Z',
          }),
        ],
      });
      ligado(db, 'm1', 1700, 'c315', { fecha: '2026-09-06' });
      db.movimiento_bancario.push(abono('m2', 1700));
      const { svc } = armar(db, { ...CON_INGRESOS, config: CONFIG_IA });
      const r = await svc.sugerirAbonos({ movimiento_ids: ['m2'] }, USER);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r.propuestas[0]).toMatchObject({
        accion: 'REVISAR',
        candidato: null,
        confianza: 0,
      });
      expect(r.propuestas[0].motivo_sin_match).toBe(
        'Hay varios cobros de vuelo que esperan exactamente este monto (al menos uno con pago parcial): revísalos y vincula el abono al que corresponda',
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('Paywise con abonos como los de prod (sin bruto ni comisión, D6)', () => {
  const RANGO = { desde: '2026-09-01', hasta: '2026-09-30', dias: 5 };

  it('NETO exacto ⇒ liga SIN escribir la comisión del cobro', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c-n', 'v293', 7000, {
          metodo_cobro: 'PAYWISE',
          comision_banco_monto: 620,
          comision_banco_pct: 8.8571,
        }),
      ],
      movimiento_bancario: [
        abono('m-n', 6380, { cuenta_bancaria_id: CTA_PW, fecha: '2026-09-15' }),
      ],
    });
    const { svc, escrituras } = armar(db);
    const r = await svc.conciliarPaywise(RANGO, USER);
    expect(r.resumen).toMatchObject({ conciliados_ahora: 1, errores: 0 });
    expect(escrituras().filter((o) => o.tabla === 'cobro_vuelo')).toEqual([]);
    expect(db.cobro_vuelo[0]).toMatchObject({ comision_banco_monto: 620 });
    expect(partesDe(db, 'c-n')).toEqual([['m-n', 6380]]);
  });

  it('la IMPORTACIÓN de la pasarela (auto-cruce) infiere la comisión por BRUTO antes de ligar (sin la inferencia rebotaría)', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c-b', 'v293', 7000, {
          metodo_cobro: 'PAYWISE',
          comision_banco_monto: 620,
          comision_banco_pct: 8.8571,
        }),
      ],
      movimiento_bancario: [
        abono('m-b', 7000, { cuenta_bancaria_id: CTA_PW, fecha: '2026-09-15' }),
      ],
    });
    const { svc } = armar(db);
    const { d } = await cruzar(svc, 'm-b');
    expect(d).toMatchObject({ resultado: 'CONCILIADO', cobro_id: 'c-b' });
    expect(db.cobro_vuelo[0]).toMatchObject({
      comision_banco_monto: null,
      comision_banco_pct: null,
    });
    expect(partesDe(db, 'c-b')).toEqual([['m-b', 7000]]);
  });

  it('la pasarela JAMÁS completa un parcial: el abono de Paywise por lo que falta no se cruza (ni con un cobro de banco ni con uno Paywise)', async () => {
    const db = mundo({
      cobro_vuelo: [
        cobro('c315', 'v315', 3400),
        cobro('c-pw', 'v332', 3400, { metodo_cobro: 'PAYWISE' }),
      ],
    });
    ligado(db, 'm1', 1700, 'c315');
    ligado(db, 'm-pw-1', 1700, 'c-pw');
    db.movimiento_bancario.push(
      abono('m-pw', 1700, { cuenta_bancaria_id: CTA_PW, fecha: '2026-09-15' }),
    );
    const { svc, escrituras } = armar(db);
    const { d } = await cruzar(svc, 'm-pw');
    expect(d).toMatchObject({ resultado: 'SIN_CANDIDATO' });
    expect(escrituras()).toEqual([]);
  });

  it('«Conciliar lo que cuadra»: un 409 de la liga llega a errores[] con el texto es-MX (sin la marca de la BD)', async () => {
    // El archivo trae bruto y una comisión que NO explica el depósito
    // (10,000 − 500 ≠ 9,000): cruza por BRUTO, se escribe la comisión del
    // archivo y la liga rebota COMISION_NO_CUADRA (la del archivo queda).
    const db = mundo({
      cobro_vuelo: [cobro('c-x', 'v293', 10000, { metodo_cobro: 'PAYWISE' })],
      movimiento_bancario: [
        abono('m-x', 9000, {
          cuenta_bancaria_id: CTA_PW,
          fecha: '2026-09-15',
          monto_bruto: 10000,
          comision_monto: 500,
        }),
      ],
    });
    const { svc } = armar(db);
    const r = await svc.conciliarPaywise(RANGO, USER);
    expect(r.resumen).toMatchObject({ conciliados_ahora: 0, errores: 1 });
    const e = r.errores[0] as { error: string; cobro_id: string };
    expect(e.cobro_id).toBe('c-x');
    expect(e.error).toMatch(/espera un depósito de \$9,500\.00 MXN/);
    expect(e.error).not.toMatch(/ABONO_NO_CUADRA|COMISION_NO_CUADRA:/);
    expect(partesDe(db, 'c-x')).toEqual([]);
  });
});
