import {
  errorCobrosLoteNoDisponibles,
  esCobrosLoteAusente,
  MENSAJE_COBROS_LOTE_NO_DISPONIBLE,
  MIGRACION_COBROS_LOTE,
} from './cobros-lote-disponible.util';

describe('cobros-lote-disponible.util', () => {
  it('el 503 lleva el code estable, el texto en es-MX y la migración', () => {
    const e = errorCobrosLoteNoDisponibles();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_COBROS_LOTE_NO_DISPONIBLE,
      error: 'CONCILIACION_COBROS_NO_DISPONIBLE',
      details: { migracion: MIGRACION_COBROS_LOTE },
    });
    expect(MIGRACION_COBROS_LOTE).toBe('20261012000002');
  });

  it('reconoce la migración ausente SOLO cuando el error nombra sus objetos', () => {
    expect(esCobrosLoteAusente({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(esCobrosLoteAusente({ code: 'PGRST205', message: 'x' })).toBe(true);
    expect(
      esCobrosLoteAusente({
        code: '42883',
        message:
          'function public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid) does not exist',
      }),
    ).toBe(true);
    expect(
      esCobrosLoteAusente({
        code: '42P01',
        message: 'relation "public.movimiento_bancario_cobro" does not exist',
      }),
    ).toBe(true);
    // Un objeto AJENO con el mismo code no es «falta esta migración».
    expect(
      esCobrosLoteAusente({
        code: '42883',
        message: 'function public.otra_cosa(uuid) does not exist',
      }),
    ).toBe(false);
    // El incidente del ENUM `moneda` (15-sep-2026) jamás se disfraza.
    expect(
      esCobrosLoteAusente({
        code: '42883',
        message: 'operator does not exist: public.moneda = text',
      }),
    ).toBe(false);
    expect(esCobrosLoteAusente(null)).toBe(false);
    expect(
      esCobrosLoteAusente({ code: '23514', message: 'ABONO_NO_CUADRA: x' }),
    ).toBe(false);
  });
});
