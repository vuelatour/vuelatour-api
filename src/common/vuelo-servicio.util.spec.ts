import { esVueloDeServicio, TIPO_PARADA_SERVICIO } from './vuelo-servicio.util';

/**
 * Regla ÚNICA de «vuelo de SERVICIO» (28-sep-2026). La usan el candado de
 * cotización, la clave `vtservicio` del Libro Dinero y el CAFÉ del semáforo
 * del calendario (panel, app y Google). Espejo de `esVueloDeServicio` del
 * panel (`lib/admin/quote-revision.ts`).
 */
describe('esVueloDeServicio', () => {
  const servicio = { tipo_parada: 'SERVICIO', pasajeros: 0 };
  const normalSinPax = { tipo_parada: 'NORMAL', pasajeros: null };

  it('parada de SERVICIO y cero pasajeros en todos los tramos ⇒ servicio', () => {
    expect(TIPO_PARADA_SERVICIO).toBe('SERVICIO');
    expect(esVueloDeServicio([servicio])).toBe(true);
    // Ferry de ida al taller + regreso: basta con UNA parada de servicio.
    expect(esVueloDeServicio([normalSinPax, servicio])).toBe(true);
  });

  it('pasajeros por TRAMO con null = 0 (el piso de 1 del vuelo no cuenta)', () => {
    expect(esVueloDeServicio([{ tipo_parada: 'SERVICIO' }])).toBe(true);
    expect(
      esVueloDeServicio([{ tipo_parada: 'SERVICIO', pasajeros: null }]),
    ).toBe(true);
    expect(
      esVueloDeServicio([{ tipo_parada: 'SERVICIO', pasajeros: '0' }]),
    ).toBe(true);
  });

  it('con pasajeros en CUALQUIER tramo activo ya no es de servicio (es del cliente)', () => {
    expect(
      esVueloDeServicio([servicio, { ...normalSinPax, pasajeros: 2 }]),
    ).toBe(false);
    expect(
      esVueloDeServicio([{ tipo_parada: 'SERVICIO', pasajeros: '3' }]),
    ).toBe(false);
  });

  it('sin parada de servicio no es de servicio (un ferry vacío es un ferry)', () => {
    expect(esVueloDeServicio([normalSinPax])).toBe(false);
    expect(esVueloDeServicio([normalSinPax, normalSinPax])).toBe(false);
  });

  it('los tramos CANCELADOS no cuentan (ni la parada ni los pasajeros)', () => {
    const cancelada = '2026-09-20T10:00:00Z';
    // La parada de servicio está en un tramo cancelado ⇒ no es de servicio.
    expect(
      esVueloDeServicio([
        { ...servicio, cancelada_at: cancelada },
        normalSinPax,
      ]),
    ).toBe(false);
    // Los pasajeros del tramo cancelado no le quitan lo de servicio.
    expect(
      esVueloDeServicio([
        servicio,
        { tipo_parada: 'NORMAL', pasajeros: 4, cancelada_at: cancelada },
      ]),
    ).toBe(true);
    // Todo cancelado ⇒ no hay tramos activos ⇒ no es de servicio.
    expect(esVueloDeServicio([{ ...servicio, cancelada_at: cancelada }])).toBe(
      false,
    );
  });

  it('sin tramos (o con basura) ⇒ false', () => {
    expect(esVueloDeServicio([])).toBe(false);
    expect(esVueloDeServicio(null)).toBe(false);
    expect(esVueloDeServicio(undefined)).toBe(false);
    expect(esVueloDeServicio([null, undefined])).toBe(false);
  });

  it('acepta filas sueltas de PostgREST (`Record<string, unknown>`) sin cast', () => {
    const filas: Array<Record<string, unknown>> = [
      { id: 'e-1', tipo_parada: 'SERVICIO', pasajeros: 0, cancelada_at: null },
    ];
    expect(esVueloDeServicio(filas)).toBe(true);
  });
});
