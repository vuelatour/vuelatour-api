import {
  FUENTE_DIARIA,
  FUENTE_HISTORICA,
  fuenteTcLegible,
} from './fuente-tc-oficial.util';
import * as servicio from '../modules/tipo-cambio/tipo-cambio.service';

/**
 * Fuente ÚNICA de las fuentes del T.C. oficial y su etiqueta (14-oct-2026):
 * vive PURA en `common/` y `TipoCambioService` la RE-EXPORTA. Si alguien
 * vuelve a definir una copia en el servicio, los utils puros (la nota «T.C.
 * A USD» de la hoja «Otros ingresos») y el servicio podrían decir distinto.
 */
describe('fuente-tc-oficial.util', () => {
  it('etiquetas legibles (las que citan celdas, notas y pendientes)', () => {
    expect(fuenteTcLegible(FUENTE_DIARIA)).toBe('open.er-api');
    expect(fuenteTcLegible(FUENTE_HISTORICA)).toBe('BCE (frankfurter)');
    expect(fuenteTcLegible('BANXICO_FIX')).toBe('Banxico FIX (histórico)');
    expect(fuenteTcLegible('OTRA')).toBe('OTRA');
    expect(fuenteTcLegible(null)).toBe('TC oficial');
    expect(fuenteTcLegible(undefined)).toBe('TC oficial');
  });

  it('el servicio re-exporta EXACTAMENTE lo mismo (sin copia)', () => {
    expect(servicio.fuenteTcLegible).toBe(fuenteTcLegible);
    expect(servicio.FUENTE_DIARIA).toBe(FUENTE_DIARIA);
    expect(servicio.FUENTE_HISTORICA).toBe(FUENTE_HISTORICA);
    expect([FUENTE_DIARIA, FUENTE_HISTORICA]).toEqual([
      'OPEN_ER_API',
      'ECB_FRANKFURTER',
    ]);
  });
});
