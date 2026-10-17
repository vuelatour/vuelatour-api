import {
  filasAfacPorVuelo,
  type EntradaAfacPorVuelo,
  type LibroParaAfacVuelo,
} from './afac-por-vuelo.util';
import type { AfacRealLeido } from '../../common/afac-real.lector';

/**
 * AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90): fuente única
 * PURA de las filas `seccion: 'AFAC_VUELO'` de «otros movimientos», su T.C.,
 * el resumen del periodo y los avisos. Números de la QA de septiembre 2026
 * (prod): #236 N621TX 2.60 h × 100 × 17.030000 = 4,427.80; #223 XB-PEV 1.00 h
 * × 100 × 17.000000 = 1,700.00.
 */

type Fila = LibroParaAfacVuelo['vuelos'][number];

function fila(extra: Partial<Fila> & { vuelo_id: string }): Fila {
  return {
    clave: `#${extra.folio ?? '1'} · Cliente`,
    folio: '1',
    cliente: 'Cliente',
    estado: 'COMPLETADO',
    es_externo: false,
    fecha: '2026-09-02',
    fecha_fin: null,
    ruta: 'CUN-CZM',
    horas_cobradas: 1,
    permiso_afac_mxn: 0,
    permiso_afac_usd_hr: 100,
    tc_costos: 17,
    ...extra,
  } as unknown as Fila;
}

function libro(
  matricula: string,
  vuelos: Fila[],
  tcPromedio: number | null = 17.25,
): LibroParaAfacVuelo {
  return {
    matricula,
    avion_color: `#${matricula.length}${matricula.length}AA00`,
    vuelos,
    totales: { tc_promedio: tcPromedio } as LibroParaAfacVuelo['totales'],
  };
}

const F236 = fila({
  vuelo_id: 'v-236',
  folio: '236',
  clave: '#236 · Ambulancia Internacional',
  fecha: '2026-09-02',
  orden_ts: '2026-09-02T14:00:00Z',
  horas_cobradas: 2.6,
  tc_costos: 17.03,
  permiso_afac_mxn: 4427.8,
});
const F223 = fila({
  vuelo_id: 'v-223',
  folio: '223',
  clave: '#223 · Morena Mia',
  fecha: '2026-09-01',
  orden_ts: '2026-09-01T15:00:00Z',
  horas_cobradas: 1,
  tc_costos: 17,
  permiso_afac_mxn: 1700,
});

function real(
  vueloId: string,
  costo: number,
  extra: Partial<AfacRealLeido> = {},
): AfacRealLeido {
  return {
    vuelo_id: vueloId,
    costo_real_mxn: costo,
    notas: null,
    capturado_por: 'u-ale',
    capturado_por_nombre: 'Alejandra Pérez',
    capturado_at: '2026-10-16T19:05:00Z',
    updated_at: '2026-10-16T19:05:00Z',
    ...extra,
  };
}

function entrada(e: Partial<EntradaAfacPorVuelo> = {}): EntradaAfacPorVuelo {
  return {
    libros: [libro('N621TX', [F236]), libro('XB-PEV', [F223], 17.1)],
    reales: new Map(),
    mesPorVuelo: new Map(),
    mesesCerrados: new Map(),
    disponible: true,
    pagos: [],
    realesDelPeriodo: [],
    ...e,
  };
}

const MARCA_PROVISION = /·\s*PROVISI[OÓ]N\s*\(/;

describe('filasAfacPorVuelo (invariante 90)', () => {
  it('casos ancla de septiembre: una fila por vuelo, cronológica entre aviones, reservado TAL CUAL en INGRESO y egreso vacío «por capturar»', () => {
    const r = filasAfacPorVuelo(entrada());
    expect(r.filas.map((f) => f.clave)).toEqual([
      '#223 · Morena Mia',
      '#236 · Ambulancia Internacional',
    ]);
    const f236 = r.filas[1];
    expect(f236).toMatchObject({
      estado: 'COMPLETADO',
      fecha_vuelo: '2026-09-02',
      concepto_egreso: 'AFAC costo real · por capturar',
      egreso_mxn: null,
      concepto_ingreso:
        'AFAC reservado · N621TX · 2.60 h × 100.00 USD/hr × T.C. 17.030000',
      ingreso_mxn: 4427.8,
      remanente_mxn: 4427.8,
      nota_ingreso:
        'Reservado = tarifa AFAC del avión × T.C. de costos del vuelo × horas cobradas (columna PERMISO AFAC de la hoja de vuelos): 100.00 × 17.030000 × 2.60 = $4,427.80',
      seccion: 'AFAC_VUELO',
    });
    expect(r.filas[0].ingreso_mxn).toBe(1700);
    // T.C. de cada fila = el `tc_promedio` del libro de su avión.
    expect(r.tcs).toEqual([17.1, 17.25]);
    expect(Object.keys(f236).at(-1)).toBe('afac');
    expect(f236.afac).toEqual({
      vuelo_id: 'v-236',
      matricula: 'N621TX',
      horas_cobradas: 2.6,
      tarifa_usd_hr: 100,
      tc_costos: 17.03,
      reservado_mxn: 4427.8,
      costo_real_mxn: null,
      remanente_mxn: 4427.8,
      capturado_por_nombre: null,
      capturado_at: null,
      notas: null,
      mes_contable: '2026-09',
      editable: true,
      motivo_no_editable: null,
      cierre_marca: null,
    });
  });

  it('con costo real: EGRESO = real, remanente = reservado − real (negativo si costó más), concepto con quién y cuándo (día Cancún) y sus notas', () => {
    const r = filasAfacPorVuelo(
      entrada({
        reales: new Map([
          ['v-236', real('v-236', 4500, { notas: 'Factura F-123' })],
          [
            'v-223',
            real('v-223', 1500, { capturado_at: '2026-10-17T03:30:00Z' }),
          ],
        ]),
      }),
    );
    const [f223, f236] = r.filas;
    expect([f236.egreso_mxn, f236.remanente_mxn]).toEqual([4500, -72.2]);
    expect(f236.concepto_egreso).toBe(
      'AFAC costo real · capturó Alejandra el 16/10/2026',
    );
    expect(f236.nota_egreso).toBe('Factura F-123');
    // 03:30 UTC del 17 = 16-oct en Cancún.
    expect(f223.concepto_egreso).toBe(
      'AFAC costo real · capturó Alejandra el 16/10/2026',
    );
    expect(f223.remanente_mxn).toBe(200);
    expect(r.resumen).toMatchObject({
      vuelos: 2,
      vuelos_con_real: 2,
      vuelos_sin_real: 0,
      reservado_mxn: 6127.8,
      costo_real_mxn: 6000,
      remanente_mxn: 127.8,
      pagado_mxn: 0,
      diferencia_pagado_mxn: -6000,
    });
  });

  it('FILA SOMBRA fuera (su dinero y su real viven en el mes destino); FILA QUE VIENE dentro con su marca en la nota', () => {
    const sombra = fila({
      vuelo_id: 'v-337',
      folio: '337',
      permiso_afac_mxn: null,
      fila_sombra: true,
      cierre_marca: 'Pasa a octubre 2026 (pendiente de cobro)',
    });
    const viene = fila({
      vuelo_id: 'v-316',
      folio: '316',
      fecha: '2026-09-28',
      permiso_afac_mxn: 4234.2,
      cierre_marca: 'Viene de septiembre 2026',
      diferido_de: '2026-09',
    });
    const r = filasAfacPorVuelo(
      entrada({
        libros: [libro('N621TX', [sombra, viene])],
        reales: new Map([['v-337', real('v-337', 999)]]),
        mesPorVuelo: new Map([['v-316', '2026-10']]),
      }),
    );
    expect(r.filas.map((f) => f.afac!.vuelo_id)).toEqual(['v-316']);
    expect(r.filas[0].nota_ingreso).toContain('\nViene de septiembre 2026');
    expect(r.filas[0].afac).toMatchObject({
      mes_contable: '2026-10',
      cierre_marca: 'Viene de septiembre 2026',
    });
  });

  it('MULTI-AVIÓN: una fila por libro con SU reservado; el real se pinta UNA vez, en la fila DUEÑA (la primera); la otra no es editable', () => {
    const a = fila({
      vuelo_id: 'v-9',
      folio: '9',
      permiso_afac_mxn: 1000,
      orden_ts: '2026-09-05T10:00:00Z',
    });
    const b = fila({
      vuelo_id: 'v-9',
      folio: '9',
      permiso_afac_mxn: 500,
      orden_ts: '2026-09-05T12:00:00Z',
    });
    const r = filasAfacPorVuelo(
      entrada({
        libros: [libro('XB-PEV', [b]), libro('N4142R', [a])],
        reales: new Map([['v-9', real('v-9', 1200)]]),
      }),
    );
    expect(
      r.filas.map((f) => [f.afac!.matricula, f.egreso_mxn, f.afac!.editable]),
    ).toEqual([
      ['N4142R', 1200, true],
      ['XB-PEV', null, false],
    ]);
    expect(r.filas[1].afac!.motivo_no_editable).toBe(
      'El costo real de este vuelo va en su fila de N4142R.',
    );
    expect(r.filas[1].concepto_egreso).toBe(
      'AFAC costo real · en su fila de N4142R',
    );
    expect(r.resumen).toMatchObject({
      vuelos: 1,
      reservado_mxn: 1500,
      costo_real_mxn: 1200,
      remanente_mxn: 300,
    });
  });

  it('sin reservado (cancelado / 0 h / XB-IJP sin tarifa) ⇒ sin fila, SALVO que tenga costo real (nunca se pierde)', () => {
    const cancelado = fila({
      vuelo_id: 'v-219',
      folio: '219',
      estado: 'CANCELADO',
      permiso_afac_mxn: 0,
    });
    const sinTarifa = fila({
      vuelo_id: 'v-ijp',
      folio: '400',
      permiso_afac_mxn: null,
      permiso_afac_usd_hr: null,
    });
    const r0 = filasAfacPorVuelo(
      entrada({ libros: [libro('XB-IJP', [cancelado, sinTarifa])] }),
    );
    expect(r0).toEqual({ filas: [], tcs: [], resumen: null, pendientes: [] });
    const r1 = filasAfacPorVuelo(
      entrada({
        libros: [libro('XB-IJP', [cancelado, sinTarifa])],
        reales: new Map([['v-219', real('v-219', 300)]]),
      }),
    );
    expect(r1.filas).toHaveLength(1);
    expect(r1.filas[0]).toMatchObject({
      estado: 'CANCELADO',
      concepto_ingreso: null,
      ingreso_mxn: null,
      egreso_mxn: 300,
      remanente_mxn: -300,
    });
    expect('nota_ingreso' in r1.filas[0]).toBe(false);
  });

  it('EXTERNOS: solo con real (no tiene tarifa) y NUNCA editable (sin avión de la flota)', () => {
    const ext = fila({
      vuelo_id: 'v-ext',
      folio: '290',
      es_externo: true,
      permiso_afac_mxn: null,
      permiso_afac_usd_hr: null,
    });
    const r = filasAfacPorVuelo(
      entrada({
        libros: [libro('EXTERNOS', [ext], null)],
        reales: new Map([['v-ext', real('v-ext', 100)]]),
      }),
    );
    expect(r.filas[0].afac).toMatchObject({ editable: false });
    expect(r.filas[0].afac!.motivo_no_editable).toContain(
      'no tiene avión de la flota',
    );
    expect(r.tcs).toEqual([null]);
  });

  it('editable: sin la migración «no habilitado» (y sin aviso de vuelos sin real); mes CERRADO ⇒ el texto del 409', () => {
    const sinMig = filasAfacPorVuelo(entrada({ disponible: false }));
    expect(sinMig.filas.every((f) => f.afac!.editable === false)).toBe(true);
    expect(sinMig.filas[0].afac!.motivo_no_editable).toBe(
      'El costo real AFAC todavía no está habilitado.',
    );
    expect(sinMig.resumen!.vuelos_sin_real).toBe(0);
    expect(sinMig.pendientes).toEqual([]);
    const cerrado = filasAfacPorVuelo(
      entrada({
        mesesCerrados: new Map([
          [
            '2026-09',
            {
              periodo: '2026-09',
              cerrado_at: '2026-10-16T20:00:00Z',
              cerrado_por_nombre: 'Alejandra Pérez',
            },
          ],
        ]),
      }),
    );
    expect(cerrado.filas[0].afac).toMatchObject({
      editable: false,
      motivo_no_editable:
        'Septiembre 2026 ya está cerrado (Alejandra, 16-oct). Reábrelo en Reportes para corregir.',
    });
  });

  it('pagos marcados: Σ con pesos, los USD sin T.C. aparte (no suman), ordenados por fecha; los 4 avisos con su texto', () => {
    const r = filasAfacPorVuelo(
      entrada({
        reales: new Map([['v-236', real('v-236', 4500)]]),
        pagos: [
          {
            gasto_id: 'g2',
            fecha: '2026-09-10',
            detalle: 'mochada · XB-PEV',
            matricula: 'XB-PEV',
            monto_mxn: 1000,
            moneda_original: null,
            monto_original: null,
          },
          {
            gasto_id: 'g1',
            fecha: '2026-09-01',
            detalle: 'Permisos VGV · XA-VGV',
            matricula: 'XA-VGV',
            monto_mxn: 5000,
            moneda_original: null,
            monto_original: null,
          },
          {
            gasto_id: 'g3',
            fecha: '2026-09-12',
            detalle: 'USD',
            matricula: null,
            monto_mxn: null,
            moneda_original: 'USD',
            monto_original: 50,
          },
        ],
        realesDelPeriodo: [
          { ...real('v-236', 4500), folio: 236 },
          { ...real('v-fuera', 250), folio: 999 },
        ],
      }),
    );
    expect(r.resumen!.pagos.map((p) => p.gasto_id)).toEqual(['g1', 'g2', 'g3']);
    expect(r.resumen).toMatchObject({
      pagado_mxn: 6000,
      pagos_sin_tc: 1,
      costo_real_mxn: 4500,
      diferencia_pagado_mxn: 1500,
      reales_fuera_de_libro_mxn: 250,
      vuelos_sin_real: 1,
    });
    expect(r.pendientes).toEqual([
      "AFAC: 1 vuelo(s) con AFAC reservado ($1,700.00) sin costo real capturado — captúralo en 'otros movimientos' del Balance general en pantalla (columna EGRESO de cada fila AFAC).",
      'AFAC: pagado a AFAC en el periodo $6,000.00 (2 gasto(s) marcado(s) «Pago de AFAC») vs costos reales capturados $4,500.00: diferencia $1,500.00. Revisa que cada pago al gestor esté marcado y que cada vuelo tenga su costo real.',
      'AFAC: 1 pago(s) de AFAC en USD sin T.C.: no suman en la comparación.',
      'AFAC: $250.00 de costo real capturado en 1 vuelo(s) que no aparecen en ningún libro del periodo (#999): revisa su avión y su fecha.',
    ]);
  });

  it('solo pagos (sin filas): resumen con los pagos y sin filas ni T.C.', () => {
    const r = filasAfacPorVuelo(
      entrada({
        libros: [],
        pagos: [
          {
            gasto_id: 'g1',
            fecha: '2026-09-01',
            detalle: 'x',
            matricula: null,
            monto_mxn: 670,
            moneda_original: null,
            monto_original: null,
          },
        ],
      }),
    );
    expect(r.filas).toEqual([]);
    expect(r.tcs).toEqual([]);
    expect(r.resumen).toMatchObject({
      vuelos: 0,
      pagado_mxn: 670,
      diferencia_pagado_mxn: 670,
    });
  });

  it('NINGÚN texto lleva la marca «sin TC» ni «· PROVISIÓN (» (barrido de todas las cadenas, con y sin real, con libro sin T.C.)', () => {
    const r = filasAfacPorVuelo(
      entrada({
        libros: [libro('N621TX', [F236], null), libro('XB-PEV', [F223])],
        reales: new Map([['v-236', real('v-236', 4500, { notas: 'n' })]]),
      }),
    );
    const textos = [
      ...r.filas.flatMap((f) => [
        f.concepto_ingreso,
        f.concepto_egreso,
        f.nota_ingreso,
        f.nota_egreso,
        f.afac!.motivo_no_editable,
      ]),
      ...r.pendientes,
    ].filter((t): t is string => typeof t === 'string');
    expect(textos.length).toBeGreaterThan(4);
    for (const t of textos) {
      expect(t).not.toMatch(/\bsin TC\b/);
      expect(t).not.toMatch(MARCA_PROVISION);
    }
  });
});
