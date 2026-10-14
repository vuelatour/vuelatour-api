import {
  CLAVE_PRECIERRE_LIGAS_USD_TC,
  DETALLE_PRECIERRE_LIGAS_USD_TC,
  DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA,
  itemPrecierreLigasUsdTc,
  textoSinVerificarLigasUsdTc,
  TITULO_PRECIERRE_LIGAS_USD_TC,
} from './ligas-usd-tc-precierre.util';
import type { LigaUsdTcFueraDeLugar } from '../conciliacion/ligas-usd-tc.util';

/**
 * Renglón del pre-cierre «Gastos en dólares conciliados con un tipo de
 * cambio fuera de lugar» (13-oct-2026, invariante 70). NO bloquea.
 */
const liga = { gasto_id: 'g1' } as unknown as LigaUsdTcFueraDeLugar;

describe('itemPrecierreLigasUsdTc', () => {
  it('textos exactos', () => {
    expect(CLAVE_PRECIERRE_LIGAS_USD_TC).toBe('gastos_usd_tc_fuera_de_lugar');
    expect(TITULO_PRECIERRE_LIGAS_USD_TC).toBe(
      'Gastos en dólares conciliados con un tipo de cambio fuera de lugar',
    );
    expect(DETALLE_PRECIERRE_LIGAS_USD_TC).toBe(
      'Su cargo del banco en pesos da un tipo de cambio a más de ±2 % del oficial del día del cargo (o fuera de la banda 15–25): casi seguro es OTRO cargo, y el T.C. que la base de datos derivó de él mueve los pesos de ese gasto en el balance y en el reparto. Revísalos en Conciliación: desvincula y vincula el cargo correcto. Si de verdad fue así, el aviso seguirá saliendo, pero no bloquea el cierre. El sistema no corrige nada solo.',
    );
    expect(DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA).toBe(
      'No se pudo revisar el tipo de cambio de los gastos en dólares conciliados: vuelve a abrir el pre-cierre en unos minutos.',
    );
  });

  it('con ligas: count = ligas.length y lectura_fallida false', () => {
    expect(
      itemPrecierreLigasUsdTc({ ligas: [liga, liga], sin_verificar: 0 }),
    ).toEqual({
      clave: 'gastos_usd_tc_fuera_de_lugar',
      titulo: TITULO_PRECIERRE_LIGAS_USD_TC,
      detalle: DETALLE_PRECIERRE_LIGAS_USD_TC,
      count: 2,
      ligas: [liga, liga],
      sin_verificar: 0,
      lectura_fallida: false,
    });
  });

  it('sin ligas ni pendientes: count 0 (oculto en el panel)', () => {
    expect(
      itemPrecierreLigasUsdTc({ ligas: [], sin_verificar: 0 }),
    ).toMatchObject({
      count: 0,
      lectura_fallida: false,
      detalle: DETALLE_PRECIERRE_LIGAS_USD_TC,
    });
  });

  it('null (lectura fallida, excepción o método ausente) ⇒ lectura_fallida con su texto', () => {
    expect(itemPrecierreLigasUsdTc(null)).toMatchObject({
      count: 0,
      ligas: [],
      sin_verificar: 0,
      lectura_fallida: true,
      detalle: DETALLE_PRECIERRE_LIGAS_USD_TC_FALLIDA,
    });
  });

  it('solo sin_verificar ⇒ lectura_fallida con el texto propio (singular y plural)', () => {
    expect(
      itemPrecierreLigasUsdTc({ ligas: [], sin_verificar: 1 }),
    ).toMatchObject({
      count: 0,
      sin_verificar: 1,
      lectura_fallida: true,
      detalle:
        'No se pudo revisar el tipo de cambio de 1 gasto en dólares conciliado: no hay T.C. oficial del día de su cargo. Vuelve a abrir el pre-cierre más tarde.',
    });
    expect(
      itemPrecierreLigasUsdTc({ ligas: [], sin_verificar: 3 }).detalle,
    ).toBe(
      'No se pudo revisar el tipo de cambio de 3 gastos en dólares conciliados: no hay T.C. oficial del día de su cargo. Vuelve a abrir el pre-cierre más tarde.',
    );
  });

  it('con ligas y sin_verificar: «Además, …» y lectura_fallida false', () => {
    const uno = itemPrecierreLigasUsdTc({ ligas: [liga], sin_verificar: 1 });
    expect(uno.lectura_fallida).toBe(false);
    expect(uno.detalle).toBe(
      `${DETALLE_PRECIERRE_LIGAS_USD_TC} Además, 1 gasto en dólares conciliado no se pudo revisar: no hay T.C. oficial del día de su cargo.`,
    );
    expect(textoSinVerificarLigasUsdTc(3, true)).toBe(
      ' Además, 3 gastos en dólares conciliados no se pudieron revisar: no hay T.C. oficial del día de su cargo.',
    );
  });
});
