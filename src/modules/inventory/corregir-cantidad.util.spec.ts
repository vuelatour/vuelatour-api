import {
  evaluarCambioCantidad,
  notaCantidadCorregida,
} from './corregir-cantidad.util';
import { type MovEliminable } from './eliminar-movimiento.util';

/**
 * Corregir la CANTIDAD de una ENTRADA (27-nov-2026, invariante 146).
 *
 * El caso REAL que lo pidió — «Aceite multigrado semisintético 15W-50», cardex
 * de producción del 27-nov-2026: la ENTRADA del 30-oct se capturó con 13 y
 * entraron 12 («por error de dedo puse 13»). Para arreglarlo, la oficina
 * registró un AJUSTE de 1 que SUMÓ otra pieza.
 */

type Entrada = Partial<MovEliminable> & {
  id: string;
  tipo: string;
  cantidad: number;
  fecha_movimiento: string;
  created_at: string;
};

const m = (o: Entrada): MovEliminable => ({
  costo_unitario_usd: 15.091,
  moneda: 'MXN',
  costo_unitario_mxn: 281.5,
  tc_usd_mxn: 18.6535,
  ...o,
});

// Cardex REAL del aceite desde septiembre (existencia al 1-sep: 120).
const APERTURA = m({
  id: 'AP',
  tipo: 'ENTRADA',
  cantidad: 120,
  fecha_movimiento: '2026-08-29',
  created_at: '2026-08-29T10:00:00Z',
});
const SEP = [
  m({
    id: 'S1',
    tipo: 'SALIDA',
    cantidad: 12,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    aeronave_matricula: 'XA-VGV',
  }),
  m({
    id: 'S2',
    tipo: 'SALIDA',
    cantidad: 24,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:01:00Z',
    aeronave_matricula: 'N4142R',
  }),
  m({
    id: 'E96',
    tipo: 'ENTRADA',
    cantidad: 96,
    fecha_movimiento: '2026-09-26',
    created_at: '2026-09-26T10:00:00Z',
  }),
  m({
    id: 'S3',
    tipo: 'SALIDA',
    cantidad: 12,
    fecha_movimiento: '2026-10-01',
    created_at: '2026-10-06T14:32:36Z',
    aeronave_matricula: 'XB-PEV',
  }),
];
const E13 = m({
  id: 'E13',
  tipo: 'ENTRADA',
  cantidad: 13,
  fecha_movimiento: '2026-10-30',
  created_at: '2026-10-29T22:08:10Z',
});
const NOV = [
  m({
    id: 'N1',
    tipo: 'SALIDA',
    cantidad: 18,
    fecha_movimiento: '2026-11-09',
    created_at: '2026-11-09T21:04:10Z',
    aeronave_matricula: 'N990GG',
  }),
  m({
    id: 'N2',
    tipo: 'SALIDA',
    cantidad: 6,
    fecha_movimiento: '2026-11-12',
    created_at: '2026-11-13T04:09:56Z',
    aeronave_matricula: 'N990GG',
  }),
  m({
    id: 'N3',
    tipo: 'SALIDA',
    cantidad: 2,
    fecha_movimiento: '2026-11-24',
    created_at: '2026-11-24T15:46:56Z',
    aeronave_matricula: 'XA-VGV',
  }),
  m({
    id: 'N4',
    tipo: 'SALIDA',
    cantidad: 10,
    fecha_movimiento: '2026-11-24',
    created_at: '2026-11-24T15:48:01Z',
    aeronave_matricula: 'XA-VGV',
  }),
  m({
    id: 'N5',
    tipo: 'SALIDA',
    cantidad: 24,
    fecha_movimiento: '2026-11-26',
    created_at: '2026-11-26T18:24:54Z',
    aeronave_matricula: 'N4142R',
  }),
];
const CARDEX = [APERTURA, ...SEP, E13, ...NOV];

describe('evaluarCambioCantidad · caso real del aceite 15W-50 (13 → 12)', () => {
  it('la captura del cliente: existencia 121 con el 13', () => {
    const r = evaluarCambioCantidad(CARDEX, 'E13', 12);
    expect(r.stock_antes).toBe(121);
  });

  it('corregir 13 → 12 se permite y la existencia baja UNA pieza (121 → 120)', () => {
    const r = evaluarCambioCantidad(CARDEX, 'E13', 12);
    expect(r.permitido).toBe(true);
    expect(r.codigo_bloqueo).toBeNull();
    expect(r.cantidad_antes).toBe(13);
    expect(r.cantidad_despues).toBe(12);
    expect(r.stock_despues).toBe(120);
    expect(r.detalle).toBe(
      'Se puede corregir la ENTRADA de 13 del 30 oct 2026: queda en 12 y la existencia pasa de 121 a 120. El costo unitario no cambia y ninguna salida cambia de costo.',
    );
  });

  it('el orden de la lista no importa (se ordena por fecha, alta e id)', () => {
    const r = evaluarCambioCantidad([...CARDEX].reverse(), 'E13', 12);
    expect(r.permitido).toBe(true);
    expect(r.stock_despues).toBe(120);
  });

  it('subir la cantidad también se permite (13 → 15: 123)', () => {
    const r = evaluarCambioCantidad(CARDEX, 'E13', 15);
    expect(r.permitido).toBe(true);
    expect(r.stock_despues).toBe(123);
  });

  it('la misma cantidad no es una corrección: SIN_CAMBIO', () => {
    const r = evaluarCambioCantidad(CARDEX, 'E13', 13);
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('SIN_CAMBIO');
    expect(r.detalle).toContain('ya tiene 13');
  });

  it('cero o negativo no es una cantidad: SIN_CAMBIO y manda a eliminarla', () => {
    for (const n of [0, -1]) {
      const r = evaluarCambioCantidad(CARDEX, 'E13', n);
      expect(r.permitido).toBe(false);
      expect(r.codigo_bloqueo).toBe('SIN_CAMBIO');
      expect(r.detalle).toContain('elimínala');
    }
  });
});

describe('evaluarCambioCantidad · candado de existencia', () => {
  // 10 entran, salen 8: de esta entrada ya salieron piezas.
  const E = m({
    id: 'E',
    tipo: 'ENTRADA',
    cantidad: 10,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
  });
  const S = m({
    id: 'S',
    tipo: 'SALIDA',
    cantidad: 8,
    fecha_movimiento: '2026-09-02',
    created_at: '2026-09-02T10:00:00Z',
    aeronave_matricula: 'XA-VGV',
  });
  const E2 = m({
    id: 'E2',
    tipo: 'ENTRADA',
    cantidad: 50,
    fecha_movimiento: '2026-09-10',
    created_at: '2026-09-10T10:00:00Z',
  });

  it('bajar hasta lo que ya salió se permite (10 → 8: existencia 0 en ese punto)', () => {
    const r = evaluarCambioCantidad([E, S, E2], 'E', 8);
    expect(r.permitido).toBe(true);
    expect(r.stock_despues).toBe(50);
  });

  it('bajar más de lo que ya salió NO: STOCK_NEGATIVO aunque HOY sobren piezas', () => {
    // Hoy hay 52, pero el 2-sep solo había las 10 de esta entrada.
    const r = evaluarCambioCantidad([E, S, E2], 'E', 5);
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('STOCK_NEGATIVO');
    expect(r.detalle).toBe(
      'Con 5 en vez de 10 la existencia quedaría en -3 al llegar la SALIDA de 8 del 2 sep 2026 a XA-VGV: de esta entrada ya salieron piezas. Lo menos que puede quedar es 8.',
    );
  });

  it('un TRASPASO entre bodegas no cuenta para la existencia', () => {
    const T = m({
      id: 'T',
      tipo: 'TRASPASO',
      cantidad: 9,
      fecha_movimiento: '2026-09-03',
      created_at: '2026-09-03T10:00:00Z',
    });
    const r = evaluarCambioCantidad([E, S, T, E2], 'E', 8);
    expect(r.permitido).toBe(true);
  });
});

describe('evaluarCambioCantidad · tipos y errores', () => {
  it('una SALIDA no se corrige aquí: ya generó su cargo al avión', () => {
    const r = evaluarCambioCantidad(CARDEX, 'N1', 12);
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('TIPO_NO_SOPORTADO');
    expect(r.detalle).toContain('elimínala');
    expect(r.detalle).toContain('captúrala de nuevo');
  });

  it('un AJUSTE o una DEVOLUCION tampoco', () => {
    for (const tipo of ['AJUSTE', 'DEVOLUCION', 'TRASPASO']) {
      const x = m({
        id: 'X',
        tipo,
        cantidad: 1,
        fecha_movimiento: '2026-11-27',
        created_at: '2026-11-27T17:01:16Z',
      });
      const r = evaluarCambioCantidad([...CARDEX, x], 'X', 2);
      expect(r.permitido).toBe(false);
      expect(r.codigo_bloqueo).toBe('TIPO_NO_SOPORTADO');
      expect(r.detalle).toContain('solo las ENTRADAS');
    }
  });

  it('un movimiento que no está en el cardex revienta (error de programación, no 409)', () => {
    expect(() => evaluarCambioCantidad(CARDEX, 'no-existe', 1)).toThrow(
      /no está en el cardex/,
    );
  });

  it('la cantidad se compara y se guarda a 2 decimales', () => {
    const r = evaluarCambioCantidad(CARDEX, 'E13', 12.004);
    expect(r.cantidad_despues).toBe(12);
    expect(r.permitido).toBe(true);
  });
});

describe('notaCantidadCorregida', () => {
  it('dice cuándo, quién, antes y ahora (fecha DD/MM/AAAA)', () => {
    expect(
      notaCantidadCorregida({
        hoy: '2026-11-27',
        quien: 'Jimmy Chi',
        antes: 13,
        despues: 12,
      }),
    ).toBe('Cantidad corregida 27/11/2026 por Jimmy Chi: antes 13, ahora 12');
  });

  it('con motivo y con la presentación por empaque que deja de aplicar', () => {
    expect(
      notaCantidadCorregida({
        hoy: '2026-11-27',
        quien: 'Jimmy Chi',
        antes: 24,
        despues: 23,
        presentacion: '2 × Caja',
        motivo: 'Error de dedo',
      }),
    ).toBe(
      'Cantidad corregida 27/11/2026 por Jimmy Chi: antes 24 (2 × Caja), ahora 23: Error de dedo',
    );
  });

  it('sin nombre no inventa quién', () => {
    expect(
      notaCantidadCorregida({
        hoy: '2026-11-27',
        quien: null,
        antes: 2.5,
        despues: 2,
      }),
    ).toBe('Cantidad corregida 27/11/2026: antes 2.5, ahora 2');
  });
});
