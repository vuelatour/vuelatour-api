import type { IngresoParaLibro } from '../../common/ingreso-resultado.util';
import type { BalanceAvionHojaOtrosIngresosPayload } from '../pyservices/pyservices.service';
import {
  filaHojaOtrosIngresos,
  fusionarOtrosIngresosFlota,
  hojaOtrosIngresosAvion,
} from './otros-ingresos-avion.util';

/**
 * Hoja «Otros ingresos» del libro de un avión (13-oct-2026, API 0.0.75,
 * invariante 67). Caso real: ING-4 de N990GG — reembolso de $46,550.80 MXN
 * del 4-sep-2026 que pagó Angel Alvarez (socio al 51 %) a la cuenta EJE
 * SCOTIA.
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

describe('filaHojaOtrosIngresos', () => {
  it('fila MXN (ING-4) LITERAL: detalle, cuenta y pesos de `filaLibroDeIngreso`', () => {
    expect(filaHojaOtrosIngresos(ING4)).toEqual({
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
    });
  });

  it('sin cuenta ⇒ «Efectivo / caja»; alias sin banco ⇒ solo el alias', () => {
    expect(filaHojaOtrosIngresos(USD)?.cuenta).toBe('Efectivo / caja');
    expect(filaHojaOtrosIngresos({ ...ING4, cuenta_banco: null })?.cuenta).toBe(
      'EJE SCOTIA',
    );
  });

  it('USD 100 × 17.5 con comisión 5 ⇒ 1,750 / 87.50 / 1,662.50 y el T.C. EXACTO', () => {
    expect(filaHojaOtrosIngresos(USD)).toMatchObject({
      clave: 'ING-9',
      categoria: 'Venta de refacciones o activos a terceros',
      detalle: 'ING-9 · Venta de hélice usada · Aerotaller del Sur',
      moneda_original: 'USD',
      monto_original: 100,
      tc_aplicado: 17.5,
      ingreso_mxn: 1750,
      comision_mxn: 87.5,
      neto_mxn: 1662.5,
    });
    const raro = filaHojaOtrosIngresos({ ...USD, tc_usd_mxn: 18.123456 });
    expect(raro?.tc_aplicado).toBe(18.123456);
  });

  it('vuelo en el detalle; anticipo o aportación ⇒ null', () => {
    expect(filaHojaOtrosIngresos({ ...ING4, vuelo_folio: 312 })?.detalle).toBe(
      'ING-4 · TRANSF INTERBANCARIA SPEI · angel alvarez · vuelo #312',
    );
    expect(
      filaHojaOtrosIngresos({ ...ING4, categoria: 'ANTICIPO_CLIENTE' }),
    ).toBeNull();
    expect(
      filaHojaOtrosIngresos({ ...ING4, categoria: 'APORTACION_PRESTAMO' }),
    ).toBeNull();
  });
});

describe('hojaOtrosIngresosAvion', () => {
  it('vacía ⇒ {filas: [], total_mxn: 0, usd: 0} y sin pendientes', () => {
    const pendientes: string[] = [];
    expect(hojaOtrosIngresosAvion([], 20, pendientes)).toEqual({
      filas: [],
      total_mxn: 0,
      usd: 0,
    });
    expect(hojaOtrosIngresosAvion([], null, pendientes).usd).toBe(0);
    expect(pendientes).toEqual([]);
  });

  it('TOTAL USD = round2(Σ neto MXN ÷ tcHojas); sin T.C. y con filas ⇒ null', () => {
    const h = hojaOtrosIngresosAvion([ING4, USD], 20, []);
    expect(h.filas.map((f) => f.clave)).toEqual(['ING-4', 'ING-9']);
    expect(h.total_mxn).toBe(48213.3);
    expect(h.usd).toBe(Math.round((48213.3 / 20) * 100) / 100);
    expect(hojaOtrosIngresosAvion([ING4], 20, []).usd).toBe(2327.54);
    expect(hojaOtrosIngresosAvion([ING4], null, []).usd).toBeNull();
  });

  it('USD SIN T.C. ⇒ fila sin MXN, pendiente LITERAL y usd null', () => {
    const pendientes: string[] = [];
    const h = hojaOtrosIngresosAvion(
      [ING4, { ...USD, tc_usd_mxn: null }],
      20,
      pendientes,
    );
    expect(h.filas[1].ingreso_mxn).toBeNull();
    expect(h.filas[1].neto_mxn).toBeNull();
    expect(h.total_mxn).toBe(46550.8);
    expect(h.usd).toBeNull();
    expect(pendientes).toEqual([
      'Hoja "Otros ingresos" (2026-09-20): ingreso ING-9 en USD sin tipo de cambio — fila sin monto MXN; la utilidad después de gastos queda vacía',
    ]);
  });

  it('un anticipo forzado no entra a la hoja', () => {
    const h = hojaOtrosIngresosAvion(
      [{ ...ING4, categoria: 'ANTICIPO_CLIENTE' }],
      20,
      [],
    );
    expect(h).toEqual({ filas: [], total_mxn: 0, usd: 0 });
  });
});

describe('fusionarOtrosIngresosFlota (hoja «otros ingresos aviones» del general)', () => {
  const hoja = (
    ingresos: IngresoParaLibro[],
    tc: number | null,
  ): BalanceAvionHojaOtrosIngresosPayload =>
    hojaOtrosIngresosAvion(ingresos, tc, []);
  const vacia = hoja([], null);

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

  it('prefijo «MATRÍCULA · », color y matrícula por fila; orden por fecha ESTABLE entre aviones; totales sumados', () => {
    const a = hoja(
      [ING4, { ...ING4, id: 'i-7', folio: 7, fecha: '2026-09-20' }],
      20,
    );
    const b = hoja([{ ...USD, id: 'i-8', folio: 8, fecha: '2026-09-04' }], 18);
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
    expect(r!.usd).toBe(Math.round(((a.usd ?? 0) + (b.usd ?? 0)) * 100) / 100);
    // Las llaves nuevas van AL FINAL de cada fila (las del libro, intactas).
    expect(Object.keys(r!.filas[0]).slice(-2)).toEqual([
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
        otros_ingresos_avion: hoja([ING4], 20),
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
