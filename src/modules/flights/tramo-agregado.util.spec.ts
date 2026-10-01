import {
  AVISO_TRAMO_CLIENTE_OPERATIVO,
  AVISO_TRAMO_COMERCIAL,
  OPERATIVA_ORDEN_BASE,
  avisoDeTramoGuardado,
  esTramoOperativo,
  ubicarTramoAgregado,
  type EscalaParaUbicar,
} from './tramo-agregado.util';

/**
 * Tramo agregado a un vuelo ya creado (30-sep-2026, API 0.0.46, caso #364):
 * ¿del cliente u operativo, y con qué `orden`?
 */

const esc = (
  orden: number,
  extra: EscalaParaUbicar = {},
): EscalaParaUbicar => ({
  orden,
  cancelada_at: null,
  taco_salida: null,
  taco_salida_origen: null,
  taco_llegada: null,
  fecha_salida_plan: null,
  ...extra,
});

/** #364 tal como quedó el 29-sep: CUN→CET y CET→PTU, ferry y COMERCIALES. */
const VUELO_364 = [
  esc(1, { fecha_salida_plan: '2026-10-01 12:30:00+00' }),
  esc(2, { fecha_salida_plan: '2026-10-01 13:30:00+00' }),
];

describe('esTramoOperativo — la regla del alta (+ servicio vacío)', () => {
  it.each([
    [{ es_ferry: true }, true],
    [{ es_ferry: true, pasajeros: 4 }, true],
    [{ es_ferry: false, pasajeros: 4 }, false],
    [{}, false],
    [{ pasajeros: 0 }, false],
    [{ tipo_parada: 'NORMAL', pasajeros: 3 }, false],
    [{ tipo_parada: 'SERVICIO' }, true],
    [{ tipo_parada: 'SERVICIO', pasajeros: 0 }, true],
    [{ tipo_parada: 'SERVICIO', pasajeros: null }, true],
    // #150 CUN→CET 5 pax «ajustar el magneto»: vuelo del cliente cotizado.
    [{ tipo_parada: 'SERVICIO', pasajeros: 5 }, false],
  ])('%j ⇒ operativo=%s', (t, esperado) => {
    expect(esTramoOperativo(t)).toBe(esperado);
  });
});

describe('ubicarTramoAgregado', () => {
  it('CASO #364: PTU→CUN con 4 pax ⇒ COMERCIAL en el orden 3 (el número de la lista), con el aviso', () => {
    const u = ubicarTramoAgregado(
      { es_ferry: false, pasajeros: 4, tipo_parada: 'NORMAL' },
      VUELO_364,
    );
    expect(u).toEqual({
      orden: 3,
      comercial: true,
      aviso: AVISO_TRAMO_COMERCIAL,
    });
    expect(u.orden).toBeLessThan(OPERATIVA_ORDEN_BASE);
  });

  it('FERRY ⇒ operativo en el rango ≥ 100, sin aviso', () => {
    expect(ubicarTramoAgregado({ es_ferry: true }, VUELO_364)).toEqual({
      orden: 100,
      comercial: false,
      aviso: null,
    });
  });

  it('ferry con operativos ya agregados ⇒ el siguiente del rango (101)', () => {
    expect(
      ubicarTramoAgregado({ es_ferry: true }, [...VUELO_364, esc(100)]).orden,
    ).toBe(101);
  });

  it('SERVICIO sin pasajeros ⇒ operativo (posicionamiento a mantenimiento)', () => {
    const u = ubicarTramoAgregado({ tipo_parada: 'SERVICIO' }, VUELO_364);
    expect(u.comercial).toBe(false);
    expect(u.orden).toBe(100);
  });

  it('SERVICIO con pasajeros ⇒ del cliente (orden 3)', () => {
    const u = ubicarTramoAgregado(
      { tipo_parada: 'SERVICIO', pasajeros: 5 },
      VUELO_364,
    );
    expect(u).toEqual({
      orden: 3,
      comercial: true,
      aviso: AVISO_TRAMO_COMERCIAL,
    });
  });

  it('sin pasajeros capturados y sin ferry ⇒ del cliente (null = el pax del vuelo, igual que el alta)', () => {
    expect(ubicarTramoAgregado({}, VUELO_364).comercial).toBe(true);
  });

  it('vuelo sin tramos ⇒ comercial 1', () => {
    expect(ubicarTramoAgregado({ pasajeros: 2 }, []).orden).toBe(1);
  });

  it('un tramo CANCELADO ocupa su número (índice único): se salta al siguiente libre', () => {
    const u = ubicarTramoAgregado({ pasajeros: 2 }, [
      esc(1),
      esc(2),
      esc(3, { cancelada_at: '2026-09-30T10:00:00Z' }),
    ]);
    expect(u.orden).toBe(4);
    expect(u.comercial).toBe(true);
  });

  it('un cancelado entre activos no estorba: el siguiente del último ACTIVO', () => {
    const u = ubicarTramoAgregado({ pasajeros: 2 }, [
      esc(1),
      esc(2, { cancelada_at: '2026-09-30T10:00:00Z' }),
      esc(3),
    ]);
    expect(u.orden).toBe(4);
  });

  it('operativo ≥ 100 SIN volar y sin fechas (ferry de regreso) ⇒ el tramo del cliente va antes: comercial', () => {
    const u = ubicarTramoAgregado({ pasajeros: 3 }, [esc(1), esc(100)]);
    expect(u).toEqual({
      orden: 2,
      comercial: true,
      aviso: AVISO_TRAMO_COMERCIAL,
    });
  });

  it('operativo ≥ 100 con salida DEDUCIDA (copia provisional) no cuenta como volado', () => {
    const u = ubicarTramoAgregado({ pasajeros: 3 }, [
      esc(1, { taco_llegada: 1000.5 }),
      esc(100, { taco_salida: 1000.5, taco_salida_origen: 'DEDUCIDO' }),
    ]);
    expect(u.comercial).toBe(true);
    expect(u.orden).toBe(2);
  });

  describe('FRENO DE CRONOLOGÍA: un operativo ≥ 100 que va ANTES ⇒ operativo con aviso', () => {
    it('el operativo ya ATERRIZÓ (vuelo completado y el cliente sigue)', () => {
      const u = ubicarTramoAgregado({ pasajeros: 2 }, [
        esc(1, { taco_salida: 999, taco_llegada: 1000 }),
        esc(100, { taco_salida: 1000, taco_llegada: 1001 }),
      ]);
      expect(u).toEqual({
        orden: 101,
        comercial: false,
        aviso: AVISO_TRAMO_CLIENTE_OPERATIVO,
      });
    });

    it('el operativo está VOLANDO (salida real del piloto)', () => {
      const u = ubicarTramoAgregado({ pasajeros: 2 }, [
        esc(1),
        esc(100, { taco_salida: 1000, taco_salida_origen: 'PILOTO' }),
      ]);
      expect(u.comercial).toBe(false);
      expect(u.orden).toBe(101);
    });

    it('la fecha planeada del operativo es ANTERIOR a la del tramo nuevo', () => {
      const u = ubicarTramoAgregado(
        { pasajeros: 2, fecha_salida_plan: new Date('2026-10-01T18:00:00Z') },
        [esc(1), esc(100, { fecha_salida_plan: '2026-10-01T15:00:00+00:00' })],
      );
      expect(u.comercial).toBe(false);
      expect(u.aviso).toBe(AVISO_TRAMO_CLIENTE_OPERATIVO);
    });

    it('fecha del operativo POSTERIOR ⇒ el nuevo va antes: comercial', () => {
      const u = ubicarTramoAgregado(
        { pasajeros: 2, fecha_salida_plan: new Date('2026-10-01T12:00:00Z') },
        [esc(1), esc(100, { fecha_salida_plan: '2026-10-01T15:00:00+00:00' })],
      );
      expect(u).toEqual({
        orden: 2,
        comercial: true,
        aviso: AVISO_TRAMO_COMERCIAL,
      });
    });

    it('un operativo ≥ 100 CANCELADO no frena', () => {
      const u = ubicarTramoAgregado({ pasajeros: 2 }, [
        esc(1, { taco_llegada: 1000 }),
        esc(100, {
          taco_salida: 1000,
          taco_llegada: 1001,
          cancelada_at: '2026-09-30T10:00:00Z',
        }),
      ]);
      expect(u.comercial).toBe(true);
      expect(u.orden).toBe(2);
    });

    it('un FERRY nuevo no necesita el freno: va al rango operativo de todos modos', () => {
      const u = ubicarTramoAgregado({ es_ferry: true }, [
        esc(1, { taco_llegada: 1000 }),
        esc(100, { taco_llegada: 1001 }),
      ]);
      expect(u).toEqual({ orden: 101, comercial: false, aviso: null });
    });
  });

  it('operativos del ALTA por debajo de 100 (itinerario operativo) cuentan para el siguiente número', () => {
    // #236: 1 ferry operativo, 2 y 3 del cliente, 4 ferry operativo.
    const u = ubicarTramoAgregado({ pasajeros: 4 }, [
      esc(1),
      esc(2),
      esc(3),
      esc(4),
    ]);
    expect(u.orden).toBe(5);
  });

  it('rango comercial lleno (99 tramos) ⇒ operativo con aviso, jamás un orden ≥ 100 comercial', () => {
    const llenos = Array.from({ length: 99 }, (_, i) => esc(i + 1));
    const u = ubicarTramoAgregado({ pasajeros: 1 }, llenos);
    expect(u.comercial).toBe(false);
    expect(u.orden).toBe(100);
  });
});

describe('avisoDeTramoGuardado (replay idempotente)', () => {
  it('fila comercial ⇒ comercial con el aviso', () => {
    expect(
      avisoDeTramoGuardado({ solo_operativa: false, pasajeros: 4 }),
    ).toEqual({ comercial: true, aviso: AVISO_TRAMO_COMERCIAL });
  });

  it('ferry operativo ⇒ sin aviso', () => {
    expect(
      avisoDeTramoGuardado({
        solo_operativa: true,
        es_ferry: true,
        pasajeros: 0,
      }),
    ).toEqual({ comercial: false, aviso: null });
  });

  it('servicio vacío operativo ⇒ sin aviso', () => {
    expect(
      avisoDeTramoGuardado({
        solo_operativa: true,
        es_ferry: false,
        tipo_parada: 'SERVICIO',
        pasajeros: null,
      }),
    ).toEqual({ comercial: false, aviso: null });
  });

  it('tramo del cliente que quedó operativo (freno o legado como el #364) ⇒ aviso', () => {
    expect(
      avisoDeTramoGuardado({
        solo_operativa: true,
        es_ferry: false,
        tipo_parada: 'NORMAL',
        pasajeros: 4,
      }),
    ).toEqual({ comercial: false, aviso: AVISO_TRAMO_CLIENTE_OPERATIVO });
  });
});
