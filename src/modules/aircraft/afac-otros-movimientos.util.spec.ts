import {
  filasAfacOtrosMovimientos,
  type LibroParaAfac,
} from './afac-otros-movimientos.util';

/**
 * PERMISOS AFAC COMO FILAS QUE SUMAN en «otros movimientos» (13-oct-2026,
 * API 0.0.74, invariante 62; supersede el bloque informativo de la
 * invariante 53). Fuente única PURA: suma lo que los libros YA traen.
 *
 * Revisión del 13-oct-2026 (antes del deploy): los permisos PAGADOS se
 * listan con egreso $0.00 «a cargo del avión» — ya restan en la cascada del
 * avión (hoja «permisos») y en el grupo PERMISO del reparto; egresarlos
 * también aquí los contaba DOS veces. La provisión sí suma (ingreso).
 */

/** Marca con que `ladoEnUsd` vacía un lado del bloque VUELATOUR. */
const MARCA_SIN_TC = /\bsin TC\b/;

type PermisoFila = {
  fecha: string | null;
  detalle: string;
  monto_mxn: number | null;
};

function libro(
  matricula: string,
  tarifa: number | null,
  afacFilas: Array<{ clave: string; afac: number | null }>,
  permisos: PermisoFila[] = [],
  opts: { tc_promedio?: number | null; avion_color?: string | null } = {},
): LibroParaAfac {
  return {
    matricula,
    avion_color: opts.avion_color === undefined ? '#112233' : opts.avion_color,
    permiso_afac_usd_hr: tarifa,
    vuelos: afacFilas.map((x) => ({
      clave: x.clave,
      permiso_afac_mxn: x.afac,
    })) as unknown as LibroParaAfac['vuelos'],
    totales: {
      permiso_afac_mxn: afacFilas.reduce<number>(
        (a, x) => a + (x.afac ?? 0),
        0,
      ),
      tc_promedio: opts.tc_promedio === undefined ? 18.5 : opts.tc_promedio,
    } as unknown as LibroParaAfac['totales'],
    permisos: {
      filas: permisos,
      total_mxn: permisos.reduce((a, f) => a + (f.monto_mxn ?? 0), 0),
      usd: null,
      usd_hr: null,
    } as unknown as LibroParaAfac['permisos'],
  };
}

const VUELOS_TST = [
  { clave: '#401', afac: 1082.5 },
  { clave: '#402', afac: 866 },
  { clave: '#403', afac: null },
  { clave: '#404', afac: 1516.5 },
];

/** Marca del amarillo de pyservices (`_MARCA_PROVISION`). */
const MARCA_PROVISION = /·\s*PROVISI[OÓ]N\s*\(/;

describe('filasAfacOtrosMovimientos (invariante 62)', () => {
  it('(a) sin libros, o un libro sin tarifa, sin provisión y sin permisos ⇒ ninguna fila', () => {
    expect(filasAfacOtrosMovimientos([])).toEqual({ filas: [], tcs: [] });
    expect(
      filasAfacOtrosMovimientos([
        libro('XB-DOS', null, [
          { clave: '#410', afac: null },
          { clave: '#411', afac: null },
        ]),
      ]),
    ).toEqual({ filas: [], tcs: [] });
  });

  it('(b) provisión del periodo (Σ columna T) y UN permiso pagado INFORMATIVO (egreso $0.00 «a cargo del avión»), apareados en UNA fila', () => {
    const r = filasAfacOtrosMovimientos([
      libro(
        'XA-TST',
        25,
        VUELOS_TST,
        [{ fecha: '2026-09-05', detalle: 'AFAC anual', monto_mxn: 2500 }],
        { tc_promedio: 18.5, avion_color: '#1F77B4' },
      ),
    ]);
    expect(r.tcs).toEqual([18.5]);
    expect(r.filas).toHaveLength(1);
    const fila = r.filas[0];
    expect(fila).toEqual({
      clave: 'AFAC · XA-TST',
      avion_color: '#1F77B4',
      fecha_vuelo: null,
      concepto_egreso:
        'permiso AFAC pagado · AFAC anual · a cargo del avión XA-TST ($2,500.00 en su hoja «permisos»)',
      egreso_mxn: 0,
      fecha_egreso: '2026-09-05',
      concepto_ingreso:
        'provisión AFAC del periodo · 3 vuelos · tarifa 25.00 USD/hr',
      ingreso_mxn: 3465,
      fecha_ingreso: null,
      remanente_mxn: 3465,
      factura: null,
      nota_ingreso: [
        'Provisión AFAC de cada vuelo de XA-TST (columna PERMISO AFAC de su hoja de vuelos): tarifa 25.00 USD/hr × T.C. de costos × horas cobradas',
        '#401 = $1,082.50',
        '#402 = $866.00',
        '#404 = $1,516.50',
      ].join('\n'),
      seccion: 'AFAC',
    });
    // Sin `estado` (no es un vuelo) y sin `nota_egreso` (un solo permiso).
    expect('estado' in fila).toBe(false);
    expect('nota_egreso' in fila).toBe(false);
    // `seccion` es la ÚLTIMA llave (goldens con JSON.stringify).
    expect(Object.keys(fila).at(-1)).toBe('seccion');
  });

  it('(c) varios permisos: un concepto con la nota línea por línea, la fecha más antigua y Σ redondeada una vez (citada, no egresada)', () => {
    const [fila] = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [
        { fecha: '2026-09-20', detalle: 'Internación', monto_mxn: 1200.004 },
        { fecha: '2026-09-02', detalle: 'AFAC anual', monto_mxn: 2500 },
      ]),
    ]).filas;
    expect(fila.concepto_egreso).toBe(
      'permisos AFAC pagados · 2 conceptos (ver nota) · a cargo del avión XA-TST ($3,700.00 en su hoja «permisos»)',
    );
    expect(fila.egreso_mxn).toBe(0);
    expect(fila.fecha_egreso).toBe('2026-09-02');
    // Una línea por permiso, en el orden de las filas del libro.
    expect(fila.nota_egreso).toBe(
      'permiso AFAC pagado · Internación = $1,200.00 · 20/09/2026\npermiso AFAC pagado · AFAC anual = $2,500.00 · 02/09/2026',
    );
    // El remanente es la provisión: los permisos no egresan aquí.
    expect(fila.remanente_mxn).toBe(3465);
  });

  it('(d) permisos USD sin T.C.: se cuentan aparte, jamás un USD sumado como pesos y NUNCA la marca «sin TC» (el egreso es $0.00)', () => {
    const [solo] = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [
        { fecha: '2026-09-05', detalle: 'Permiso USD', monto_mxn: null },
      ]),
    ]).filas;
    expect(solo.concepto_egreso).toBe(
      'permiso AFAC pagado · Permiso USD · a cargo del avión XA-TST (en USD sin T.C. en su hoja «permisos»)',
    );
    expect(solo.concepto_egreso).not.toMatch(MARCA_SIN_TC);
    expect(solo.egreso_mxn).toBe(0);
    expect(solo.remanente_mxn).toBe(3465);

    const [mixto] = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [
        { fecha: '2026-09-05', detalle: 'AFAC anual', monto_mxn: 2500 },
        { fecha: '2026-09-07', detalle: 'Permiso USD', monto_mxn: null },
      ]),
    ]).filas;
    expect(mixto.concepto_egreso).toBe(
      'permisos AFAC pagados · 2 conceptos (ver nota) · a cargo del avión XA-TST ($2,500.00 en su hoja «permisos»; 1 en USD sin T.C.)',
    );
    expect(mixto.concepto_egreso).not.toMatch(MARCA_SIN_TC);
    expect(mixto.egreso_mxn).toBe(0);
    expect(mixto.remanente_mxn).toBe(3465);
    expect(mixto.nota_egreso).toBe(
      'permiso AFAC pagado · AFAC anual = $2,500.00 · 05/09/2026\npermiso AFAC pagado · Permiso USD = — · 07/09/2026',
    );
  });

  it('(e) solo permisos (sin tarifa ni provisión): el lado ingreso vacío, egreso $0.00 informativo y remanente 0 (la fila no mueve TOTALES)', () => {
    const [fila] = filasAfacOtrosMovimientos([
      libro(
        'XB-DOS',
        null,
        [{ clave: '#410', afac: null }],
        [{ fecha: null, detalle: 'Permiso', monto_mxn: 1200.004 }],
      ),
    ]).filas;
    expect(fila.concepto_ingreso).toBeNull();
    expect(fila.ingreso_mxn).toBeNull();
    expect(fila.fecha_ingreso).toBeNull();
    expect('nota_ingreso' in fila).toBe(false);
    expect(fila.concepto_egreso).toBe(
      'permiso AFAC pagado · Permiso · a cargo del avión XB-DOS ($1,200.00 en su hoja «permisos»)',
    );
    expect(fila.egreso_mxn).toBe(0);
    expect(fila.fecha_egreso).toBeNull();
    expect(fila.remanente_mxn).toBe(0);
    expect(Object.is(fila.remanente_mxn, -0)).toBe(false);
  });

  it('(e′) solo permisos USD sin T.C. y sin provisión: egreso $0.00 y remanente 0 (informativa, sin la marca «sin TC»)', () => {
    const [fila] = filasAfacOtrosMovimientos([
      libro(
        'XB-DOS',
        null,
        [],
        [{ fecha: '2026-09-05', detalle: 'Permiso USD', monto_mxn: null }],
      ),
    ]).filas;
    expect(fila.ingreso_mxn).toBeNull();
    expect(fila.egreso_mxn).toBe(0);
    expect(fila.remanente_mxn).toBe(0);
    expect(fila.concepto_egreso).toBe(
      'permiso AFAC pagado · Permiso USD · a cargo del avión XB-DOS (en USD sin T.C. en su hoja «permisos»)',
    );
    expect(fila.concepto_egreso).not.toMatch(MARCA_SIN_TC);
  });

  it('(f) solo provisión: el lado egreso vacío y remanente = provisión', () => {
    const [fila] = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST),
    ]).filas;
    expect(fila.concepto_egreso).toBeNull();
    expect(fila.egreso_mxn).toBeNull();
    expect(fila.fecha_egreso).toBeNull();
    expect('nota_egreso' in fila).toBe(false);
    expect(fila.ingreso_mxn).toBe(3465);
    expect(fila.remanente_mxn).toBe(3465);
  });

  it('(g) un solo vuelo en singular y sin tarifa: sin « · tarifa …» ni «: tarifa …»', () => {
    const [fila] = filasAfacOtrosMovimientos([
      libro('XA-TST', null, [{ clave: '#401 · Cliente Uno', afac: 1082.5 }]),
    ]).filas;
    expect(fila.concepto_ingreso).toBe('provisión AFAC del periodo · 1 vuelo');
    expect(fila.nota_ingreso).toBe(
      'Provisión AFAC de cada vuelo de XA-TST (columna PERMISO AFAC de su hoja de vuelos)\n#401 · Cliente Uno = $1,082.50',
    );
  });

  it('(h) centavos sin arrastrar flotantes', () => {
    const r = filasAfacOtrosMovimientos([
      libro('A', 10, [
        { clave: '#1', afac: 0.1 },
        { clave: '#2', afac: 0.2 },
      ]),
      libro('B', 10, [{ clave: '#3', afac: 0.3 }]),
    ]);
    expect(r.filas.map((f) => f.ingreso_mxn)).toEqual([0.3, 0.3]);
    expect(r.filas.map((f) => f.remanente_mxn)).toEqual([0.3, 0.3]);
  });

  it('(i) libro sin T.C. promedio ⇒ su T.C. null (se propaga al bloque VUELATOUR)', () => {
    const r = filasAfacOtrosMovimientos([
      libro(
        'XB-ANU',
        null,
        [],
        [{ fecha: '2026-10-02', detalle: 'Permiso', monto_mxn: 2549 }],
        { tc_promedio: null },
      ),
    ]);
    expect(r.filas).toHaveLength(1);
    expect(r.tcs).toEqual([null]);
  });

  it('(j) una fila por avión en el orden de los libros; EXTERNOS sin nada no genera fila; T.C. alineados', () => {
    const r = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [], { tc_promedio: 18.5 }),
      libro('EXTERNOS', null, []),
      libro(
        'XB-DOS',
        null,
        [],
        [{ fecha: '2026-09-02', detalle: 'Permiso', monto_mxn: 1200 }],
        { tc_promedio: 17.25 },
      ),
    ]);
    expect(r.filas.map((f) => f.clave)).toEqual([
      'AFAC · XA-TST',
      'AFAC · XB-DOS',
    ]);
    expect(r.tcs).toEqual([18.5, 17.25]);
    expect(r.filas.every((f) => f.seccion === 'AFAC')).toBe(true);
  });

  it('(k) ningún texto lleva la marca «· PROVISIÓN (» del amarillo de pyservices', () => {
    const r = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [
        { fecha: '2026-09-20', detalle: 'Internación', monto_mxn: 1200 },
        { fecha: '2026-09-02', detalle: 'AFAC anual', monto_mxn: null },
      ]),
      libro('XB-DOS', null, [{ clave: '#410', afac: 500 }]),
    ]);
    const textos = r.filas.flatMap((f) => [
      f.concepto_ingreso,
      f.nota_ingreso,
      f.concepto_egreso,
      f.nota_egreso,
    ]);
    expect(textos.filter(Boolean).length).toBeGreaterThan(0);
    for (const t of textos) {
      if (t) expect(t).not.toMatch(MARCA_PROVISION);
    }
  });

  it('(l) UN PERMISO PAGADO, UNA VEZ: ninguna fila egresa pesos (ya restan en la cascada del avión) y ninguna lleva la marca «sin TC»; el remanente es la provisión', () => {
    const r = filasAfacOtrosMovimientos([
      libro('XA-TST', 25, VUELOS_TST, [
        { fecha: '2026-09-20', detalle: 'Internación', monto_mxn: 1200 },
        { fecha: '2026-09-02', detalle: 'AFAC anual', monto_mxn: null },
      ]),
      libro(
        'XB-ANU',
        null,
        [],
        [
          { fecha: '2026-10-05', detalle: 'Permiso', monto_mxn: 2549 },
          { fecha: '2026-10-05', detalle: 'Permiso', monto_mxn: 2969 },
        ],
      ),
    ]);
    expect(r.filas.map((f) => f.egreso_mxn)).toEqual([0, 0]);
    expect(r.filas.map((f) => f.remanente_mxn)).toEqual([3465, 0]);
    expect(r.filas[1].concepto_egreso).toBe(
      'permisos AFAC pagados · 2 conceptos (ver nota) · a cargo del avión XB-ANU ($5,518.00 en su hoja «permisos»)',
    );
    for (const f of r.filas) {
      expect(f.concepto_egreso ?? '').not.toMatch(MARCA_SIN_TC);
    }
  });
});
