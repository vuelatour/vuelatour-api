import {
  usdDeIngresoAvion,
  type ConversionIngreso,
  type IngresoParaLibro,
  type TcGastoLigado,
  type TcOficialDia,
} from '../../common/ingreso-resultado.util';
import type { BalanceAvionHojaOtrosIngresosPayload } from '../pyservices/pyservices.service';
import {
  filaHojaOtrosIngresos,
  fusionarOtrosIngresosFlota,
  hojaOtrosIngresosAvion,
  notaTcUsdIngreso,
} from './otros-ingresos-avion.util';

/**
 * Hoja «Otros ingresos» del libro de un avión (13-oct-2026, API 0.0.75,
 * invariante 67). Caso real: ING-4 de N990GG — reembolso de $46,550.80 MXN
 * del 4-sep-2026 que pagó Angel Alvarez (socio al 51 %) a la cuenta EJE
 * SCOTIA.
 *
 * CONVERSIÓN ÚNICA (decisión del cliente del 14-oct-2026, API 0.0.77): cada
 * fila trae su `tc_usd` / `neto_usd` / `tc_usd_origen` / `tc_usd_nota` de
 * `usdDeIngresoAvion` (la MISMA del reparto y del tablero) y TOTAL USD =
 * round2(Σ NETO USD): ING-4 con el oficial de su día (16.9479) = 2,746.70 —
 * antes ÷ el T.C. de las hojas.
 */
const ING4: IngresoParaLibro = {
  id: 'i-4',
  folio: 4,
  categoria: 'REEMBOLSO_DEVOLUCION',
  fecha: '2026-09-04',
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  monto: 46550.8,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  cliente_nombre: null,
  pagador: 'angel alvarez',
  vuelo_folio: null,
  matricula: 'N990GG',
  aeronave_color: '#F59E0B',
  aeronave_id: 'av-n990gg',
  notas: 'reembolso del pago del serv de 50 hrs en toledo, fact 53',
  cuenta_alias: 'EJE SCOTIA',
  cuenta_banco: 'Scotiabank',
};

/** Ingreso USD 100 con T.C. propio 17.5 y comisión bancaria de 5 USD. */
const USD: IngresoParaLibro = {
  ...ING4,
  id: 'i-9',
  folio: 9,
  categoria: 'VENTA_ACTIVO',
  fecha: '2026-09-20',
  descripcion: 'Venta de hélice usada',
  monto: 100,
  comision_monto: 5,
  moneda: 'USD',
  tc_usd_mxn: 17.5,
  pagador: null,
  cliente_nombre: 'Aerotaller del Sur',
  notas: null,
  cuenta_alias: null,
  cuenta_banco: null,
};

/** T.C. oficial del 4-sep-2026 (open.er-api), el de producción. */
const OFICIAL_0904: TcOficialDia = {
  tc: 16.9479,
  fecha_dato: '2026-09-04',
  fuente: 'OPEN_ER_API',
};
const NOTA_OFICIAL_0904 =
  'T.C. oficial de referencia del día del ingreso (open.er-api, dato del 2026-09-04): el ingreso en pesos no traía tipo de cambio.';

const convDe = (
  i: IngresoParaLibro,
  oficial: TcOficialDia | null = OFICIAL_0904,
  gastoLigado: TcGastoLigado | null = null,
): ConversionIngreso =>
  usdDeIngresoAvion(i, { oficialDelDia: oficial, gastoLigado });

/** Conversiones por id con el oficial del 4-sep para los MXN. */
const conversionesDe = (
  ingresos: IngresoParaLibro[],
  oficial: TcOficialDia | null = OFICIAL_0904,
): Map<string, ConversionIngreso> =>
  new Map(ingresos.map((i) => [i.id, convDe(i, oficial)]));

describe('filaHojaOtrosIngresos', () => {
  it('fila MXN (ING-4) LITERAL: pesos de `filaLibroDeIngreso` y, AL FINAL, T.C. A USD / NETO USD del oficial de su día', () => {
    const f = filaHojaOtrosIngresos(ING4, convDe(ING4));
    expect(f).toEqual({
      ingreso_id: 'i-4',
      clave: 'ING-4',
      fecha: '2026-09-04',
      categoria: 'Reembolsos y devoluciones recibidos',
      detalle: 'ING-4 · TRANSF INTERBANCARIA SPEI · angel alvarez',
      moneda_original: 'MXN',
      monto_original: 46550.8,
      tc_aplicado: null,
      ingreso_mxn: 46550.8,
      comision_mxn: null,
      neto_mxn: 46550.8,
      cuenta: 'EJE SCOTIA · Scotiabank',
      notas: 'reembolso del pago del serv de 50 hrs en toledo, fact 53',
      tc_usd: 16.9479,
      neto_usd: 2746.7,
      tc_usd_origen: 'OFICIAL_DEL_DIA',
      tc_usd_nota: NOTA_OFICIAL_0904,
    });
    expect(Object.keys(f!).slice(-4)).toEqual([
      'tc_usd',
      'neto_usd',
      'tc_usd_origen',
      'tc_usd_nota',
    ]);
  });

  it('sin cuenta ⇒ «Efectivo / caja»; alias sin banco ⇒ solo el alias', () => {
    expect(filaHojaOtrosIngresos(USD, convDe(USD))?.cuenta).toBe(
      'Efectivo / caja',
    );
    const sinBanco = { ...ING4, cuenta_banco: null };
    expect(filaHojaOtrosIngresos(sinBanco, convDe(sinBanco))?.cuenta).toBe(
      'EJE SCOTIA',
    );
  });

  it('USD 100 × 17.5 con comisión 5 ⇒ 1,750 / 87.50 / 1,662.50, el T.C. EXACTO y NETO USD 95 sin T.C. A USD', () => {
    expect(filaHojaOtrosIngresos(USD, convDe(USD))).toMatchObject({
      clave: 'ING-9',
      categoria: 'Venta de refacciones o activos a terceros',
      detalle: 'ING-9 · Venta de hélice usada · Aerotaller del Sur',
      moneda_original: 'USD',
      monto_original: 100,
      tc_aplicado: 17.5,
      ingreso_mxn: 1750,
      comision_mxn: 87.5,
      neto_mxn: 1662.5,
      tc_usd: null,
      neto_usd: 95,
      tc_usd_origen: null,
      tc_usd_nota: null,
    });
    const raro = { ...USD, tc_usd_mxn: 18.123456 };
    expect(filaHojaOtrosIngresos(raro, convDe(raro))?.tc_aplicado).toBe(
      18.123456,
    );
  });

  it('T.C. propio en pesos ⇒ origen PROPIO, sin nota; vuelo en el detalle; anticipo o aportación ⇒ null', () => {
    const propio = { ...ING4, tc_usd_mxn: 17.5 };
    expect(filaHojaOtrosIngresos(propio, convDe(propio))).toMatchObject({
      tc_usd: 17.5,
      neto_usd: 2660.05,
      tc_usd_origen: 'PROPIO',
      tc_usd_nota: null,
    });
    const conVuelo = { ...ING4, vuelo_folio: 312 };
    expect(filaHojaOtrosIngresos(conVuelo, convDe(conVuelo))?.detalle).toBe(
      'ING-4 · TRANSF INTERBANCARIA SPEI · angel alvarez · vuelo #312',
    );
    for (const categoria of ['ANTICIPO_CLIENTE', 'APORTACION_PRESTAMO']) {
      const i = { ...ING4, categoria };
      expect([categoria, filaHojaOtrosIngresos(i, convDe(i))]).toEqual([
        categoria,
        null,
      ]);
    }
  });
});

describe('notaTcUsdIngreso', () => {
  it('OFICIAL_DEL_DIA, GASTO_LIGADO (hojas o fila de vuelo) LITERALES; PROPIO / USD ⇒ null', () => {
    expect(notaTcUsdIngreso(convDe(ING4))).toBe(NOTA_OFICIAL_0904);
    const reembolso = { ...ING4, monto: 45483.6, gasto_id: '70e8c3a4-1111' };
    const hojas: TcGastoLigado = {
      gasto_id: '70e8c3a4-1111',
      tc: 17.237699,
      fecha: '2026-09-15',
      lugar: 'T.C. promedio de las hojas',
    };
    expect(notaTcUsdIngreso(convDe(reembolso, OFICIAL_0904, hojas))).toBe(
      'T.C. con el que este libro convierte el gasto que reembolsa (gasto 70e8c3a4 del 15-sep-2026, T.C. promedio de las hojas): reembolso y gasto se anulan en este libro.',
    );
    expect(
      notaTcUsdIngreso(
        convDe(reembolso, OFICIAL_0904, {
          ...hojas,
          lugar: 'T.C. de costos del vuelo #430',
        }),
      ),
    ).toBe(
      'T.C. con el que este libro convierte el gasto que reembolsa (gasto 70e8c3a4 del 15-sep-2026, T.C. de costos del vuelo #430): reembolso y gasto se anulan en este libro.',
    );
    expect(notaTcUsdIngreso(convDe({ ...ING4, tc_usd_mxn: 17.5 }))).toBeNull();
    expect(notaTcUsdIngreso(convDe(USD))).toBeNull();
    expect(notaTcUsdIngreso(convDe(ING4, null))).toBeNull();
  });
});

describe('hojaOtrosIngresosAvion', () => {
  it('vacía ⇒ {filas: [], total_mxn: 0, usd: 0, usd_por_ingreso: true} y sin pendientes', () => {
    const pendientes: string[] = [];
    expect(hojaOtrosIngresosAvion([], new Map(), pendientes)).toEqual({
      filas: [],
      total_mxn: 0,
      usd: 0,
      usd_por_ingreso: true,
    });
    expect(pendientes).toEqual([]);
  });

  it('TOTAL USD = round2(Σ NETO USD): ING-4 ⇒ 2,746.70; ING-4 + USD 100 − 5 ⇒ 2,841.70; `usd_por_ingreso` ÚLTIMA llave', () => {
    const solo = hojaOtrosIngresosAvion([ING4], conversionesDe([ING4]), []);
    expect(solo.usd).toBe(2746.7);
    const h = hojaOtrosIngresosAvion(
      [ING4, USD],
      conversionesDe([ING4, USD]),
      [],
    );
    expect(h.filas.map((f) => f.clave)).toEqual(['ING-4', 'ING-9']);
    expect(h.total_mxn).toBe(48213.3);
    expect(h.usd).toBe(2841.7);
    expect(Object.keys(h)).toEqual([
      'filas',
      'total_mxn',
      'usd',
      'usd_por_ingreso',
    ]);
  });

  it('MXN sin T.C. propio ni oficial de su día ⇒ fila sin NETO USD, usd null y pendiente LITERAL', () => {
    const pendientes: string[] = [];
    const h = hojaOtrosIngresosAvion(
      [ING4, USD],
      conversionesDe([ING4, USD], null),
      pendientes,
    );
    expect(h.filas[0]).toMatchObject({ tc_usd: null, neto_usd: null });
    expect(h.usd).toBeNull();
    expect(pendientes).toEqual([
      'Hoja "Otros ingresos" (2026-09-04): ingreso ING-4 en pesos sin T.C. propio ni T.C. oficial de su día — fila sin USD; la utilidad después de gastos queda vacía',
    ]);
    // Sin conversión del llamador: la regla sin contexto (nunca un T.C.
    // inventado).
    const sinMapa: string[] = [];
    expect(hojaOtrosIngresosAvion([ING4], new Map(), sinMapa).usd).toBeNull();
    expect(sinMapa).toHaveLength(1);
  });

  it('USD SIN T.C. (el CHECK lo impide) ⇒ fila sin MXN pero su NETO USD SÍ suma, con pendiente LITERAL', () => {
    const pendientes: string[] = [];
    const sinTc = { ...USD, tc_usd_mxn: null };
    const h = hojaOtrosIngresosAvion(
      [ING4, sinTc],
      conversionesDe([ING4, sinTc]),
      pendientes,
    );
    expect(h.filas[1]).toMatchObject({
      ingreso_mxn: null,
      neto_mxn: null,
      neto_usd: 95,
    });
    expect(h.total_mxn).toBe(46550.8);
    expect(h.usd).toBe(2841.7);
    expect(pendientes).toEqual([
      'Hoja "Otros ingresos" (2026-09-20): ingreso ING-9 en USD sin tipo de cambio — fila sin monto MXN (su NETO USD sí suma)',
    ]);
  });

  it('reembolso cuyo gasto NO cuenta en este libro ⇒ pendiente LITERAL (oficial del día o T.C. propio); ligado o gasto del libro ⇒ ninguno', () => {
    const reembolso = { ...ING4, gasto_id: 'g-otro-mes' };
    const p1: string[] = [];
    hojaOtrosIngresosAvion([reembolso], conversionesDe([reembolso]), p1);
    expect(p1).toEqual([
      'Hoja "Otros ingresos" (2026-09-04): ING-4 reembolsa un gasto que este libro no cuenta (otro mes, otro avión u otra moneda): se convirtió con el T.C. oficial de su día y no se anula exacto con su gasto',
    ]);
    const propio = { ...reembolso, tc_usd_mxn: 17.5 };
    const p2: string[] = [];
    hojaOtrosIngresosAvion([propio], conversionesDe([propio]), p2);
    expect(p2).toEqual([
      'Hoja "Otros ingresos" (2026-09-04): ING-4 reembolsa un gasto que este libro no cuenta (otro mes, otro avión u otra moneda): se convirtió con su T.C. propio y no se anula exacto con su gasto',
    ]);
    // El gasto SÍ está en el libro (T.C. propio capturado: manda) ⇒ nada.
    const p3: string[] = [];
    hojaOtrosIngresosAvion(
      [propio],
      conversionesDe([propio]),
      p3,
      new Set(['g-otro-mes']),
    );
    expect(p3).toEqual([]);
    // Ligado ⇒ nada (se anula con su gasto).
    const ligado: TcGastoLigado = {
      gasto_id: 'g-otro-mes',
      tc: 17.237699,
      fecha: '2026-09-15',
      lugar: 'T.C. promedio de las hojas',
    };
    const p4: string[] = [];
    const h = hojaOtrosIngresosAvion(
      [reembolso],
      new Map([[reembolso.id, convDe(reembolso, OFICIAL_0904, ligado)]]),
      p4,
      new Set(['g-otro-mes']),
    );
    expect(p4).toEqual([]);
    expect(h.filas[0]).toMatchObject({
      tc_usd: 17.237699,
      neto_usd: 2700.52,
      tc_usd_origen: 'GASTO_LIGADO',
    });
  });

  it('un anticipo forzado no entra a la hoja', () => {
    const anticipo = { ...ING4, categoria: 'ANTICIPO_CLIENTE' };
    const h = hojaOtrosIngresosAvion(
      [anticipo],
      conversionesDe([anticipo]),
      [],
    );
    expect(h).toEqual({
      filas: [],
      total_mxn: 0,
      usd: 0,
      usd_por_ingreso: true,
    });
  });
});

describe('fusionarOtrosIngresosFlota (hoja «otros ingresos aviones» del general)', () => {
  const hoja = (
    ingresos: IngresoParaLibro[],
    oficial: TcOficialDia | null = OFICIAL_0904,
  ): BalanceAvionHojaOtrosIngresosPayload =>
    hojaOtrosIngresosAvion(ingresos, conversionesDe(ingresos, oficial), []);
  const vacia = hoja([]);

  it('sin filas en ningún libro ⇒ null', () => {
    expect(fusionarOtrosIngresosFlota([])).toBeNull();
    expect(
      fusionarOtrosIngresosFlota([
        {
          matricula: 'N990GG',
          avion_color: '#F59E0B',
          otros_ingresos_avion: vacia,
        },
        {
          matricula: 'EXTERNOS',
          avion_color: null,
          otros_ingresos_avion: vacia,
        },
        { matricula: 'XB-VIEJO', avion_color: null },
      ]),
    ).toBeNull();
  });

  it('prefijo «MATRÍCULA · », color y matrícula por fila; orden por fecha ESTABLE entre aviones; totales sumados y `usd_por_ingreso`', () => {
    const a = hoja([
      ING4,
      { ...ING4, id: 'i-7', folio: 7, fecha: '2026-09-20' },
    ]);
    const b = hoja([{ ...USD, id: 'i-8', folio: 8, fecha: '2026-09-04' }]);
    const r = fusionarOtrosIngresosFlota([
      { matricula: 'N990GG', avion_color: '#F59E0B', otros_ingresos_avion: a },
      { matricula: 'XB-VIEJO', avion_color: null, otros_ingresos_avion: vacia },
      { matricula: 'XA-VGV', avion_color: '#3B82F6', otros_ingresos_avion: b },
    ]);
    expect(r).not.toBeNull();
    expect(
      r!.filas.map((f) => [f.fecha, f.detalle, f.matricula, f.avion_color]),
    ).toEqual([
      [
        '2026-09-04',
        'N990GG · ING-4 · TRANSF INTERBANCARIA SPEI · angel alvarez',
        'N990GG',
        '#F59E0B',
      ],
      [
        '2026-09-04',
        'XA-VGV · ING-8 · Venta de hélice usada · Aerotaller del Sur',
        'XA-VGV',
        '#3B82F6',
      ],
      [
        '2026-09-20',
        'N990GG · ING-7 · TRANSF INTERBANCARIA SPEI · angel alvarez',
        'N990GG',
        '#F59E0B',
      ],
    ]);
    expect(r!.total_mxn).toBe(
      Math.round((a.total_mxn + b.total_mxn) * 100) / 100,
    );
    // 2 × 2,746.70 + 95 = 5,588.40 = Σ NETO USD de todas las filas.
    expect(r!.usd).toBe(5588.4);
    expect(r!.usd).toBe(
      Math.round(r!.filas.reduce((s, f) => s + (f.neto_usd ?? 0), 0) * 100) /
        100,
    );
    expect(Object.keys(r!)).toEqual([
      'filas',
      'total_mxn',
      'usd',
      'usd_por_ingreso',
    ]);
    expect(r!.usd_por_ingreso).toBe(true);
    // Las llaves de la FLOTA van AL FINAL de cada fila (las del libro,
    // incluidas las 4 del 0.0.77, intactas antes).
    expect(Object.keys(r!.filas[0]).slice(-6)).toEqual([
      'tc_usd',
      'neto_usd',
      'tc_usd_origen',
      'tc_usd_nota',
      'matricula',
      'avion_color',
    ]);
    expect(a.filas[0].detalle).toBe(
      'ING-4 · TRANSF INTERBANCARIA SPEI · angel alvarez',
    );
  });

  it('un libro con filas y usd null PROPAGA null (jamás ?? 0)', () => {
    const r = fusionarOtrosIngresosFlota([
      {
        matricula: 'N990GG',
        avion_color: null,
        otros_ingresos_avion: hoja([ING4]),
      },
      {
        matricula: 'XA-VGV',
        avion_color: null,
        otros_ingresos_avion: hoja([ING4], null),
      },
    ]);
    expect(r!.usd).toBeNull();
    expect(r!.total_mxn).toBe(93101.6);
  });
});
