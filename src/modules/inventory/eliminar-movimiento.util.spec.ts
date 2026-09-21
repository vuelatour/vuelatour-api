import {
  cantidadTxt,
  codigoDeErrorEliminacion,
  describirMovimiento,
  esTablaInexistente,
  evaluarEliminacion,
  fechaCardexEsMx,
  mensajeDeErrorEliminacion,
  montoTxt,
  type MovEliminable,
} from './eliminar-movimiento.util';

/**
 * Baja de un movimiento de cardex (21-sep-2026) — el candado NUMÉRICO.
 *
 * El caso REAL que lo pidió (producto «Aceite multigrado semisintético
 * 15W-50», cardex de producción): el 29-ago se capturaron por error una
 * SALIDA de 10 a XA-VGV, una ENTRADA de 1 a $350 MXN y una SALIDA de 1 a
 * XA-VGV, encima de una ENTRADA de 120 a $0 del mismo día. Lo que se prueba
 * aquí es EXACTAMENTE qué orden de borrado se permite y cuál no, para que el
 * costo FIFO que ya viajó a los gastos de los aviones no se mueva jamás.
 */

type Entrada = Partial<MovEliminable> & {
  id: string;
  tipo: string;
  cantidad: number;
  fecha_movimiento: string;
  created_at: string;
};

const m = (o: Entrada): MovEliminable => ({
  costo_unitario_usd: 0,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: null,
  ...o,
});

/** Capa comprada en PESOS (lo normal en bodega). */
const enPesos = (mxn: number, tc = 17.51) => ({
  moneda: 'MXN',
  costo_unitario_mxn: mxn,
  tc_usd_mxn: tc,
  costo_unitario_usd: Number((mxn / tc).toFixed(4)),
});

// ===== Cardex REAL del aceite 15W-50 (existencia final: 110) =====
const E1 = m({
  id: 'E1',
  tipo: 'ENTRADA',
  cantidad: 30,
  fecha_movimiento: '2026-07-13',
  created_at: '2026-07-13T15:37:31Z',
  ...enPesos(1658.33),
});
const S1 = m({
  id: 'S1',
  tipo: 'SALIDA',
  cantidad: 4,
  fecha_movimiento: '2026-07-17',
  created_at: '2026-07-20T16:46:52Z',
  aeronave_matricula: 'N4142R',
  ...enPesos(1658.33),
});
const S2 = m({
  id: 'S2',
  tipo: 'SALIDA',
  cantidad: 2,
  fecha_movimiento: '2026-07-20',
  created_at: '2026-07-20T16:48:21Z',
  aeronave_matricula: 'XB-PEV',
  ...enPesos(1658.33),
});
const S3 = m({
  id: 'S3',
  tipo: 'SALIDA',
  cantidad: 24,
  fecha_movimiento: '2026-08-06',
  created_at: '2026-08-07T20:07:07Z',
  aeronave_matricula: 'N990GG',
  ...enPesos(1658.33),
});
const E2 = m({
  id: 'E2',
  tipo: 'ENTRADA',
  cantidad: 120,
  fecha_movimiento: '2026-08-29',
  created_at: '2026-08-29T17:36:43Z',
});
const S4 = m({
  id: 'S4',
  tipo: 'SALIDA',
  cantidad: 1,
  fecha_movimiento: '2026-08-29',
  created_at: '2026-08-29T19:59:12Z',
  aeronave_matricula: 'XA-VGV',
});
const E3 = m({
  id: 'E3',
  tipo: 'ENTRADA',
  cantidad: 1,
  fecha_movimiento: '2026-08-29',
  created_at: '2026-08-29T20:00:28Z',
  ...enPesos(350, 18),
});
const S5 = m({
  id: 'S5',
  tipo: 'SALIDA',
  cantidad: 10,
  fecha_movimiento: '2026-08-29',
  created_at: '2026-08-29T20:01:44Z',
  aeronave_matricula: 'XA-VGV',
});

// Desordenado a propósito: el helper ordena (sortChrono), no confía en la lista.
const CARDEX = [S5, E1, S3, E3, S1, E2, S4, S2];

describe('evaluarEliminacion · caso real del 29-ago (aceite 15W-50)', () => {
  it('la SALIDA de 10 (la última capturada) SE PUEDE eliminar: nadie depende de ella', () => {
    const r = evaluarEliminacion(CARDEX, 'S5');
    expect(r.permitido).toBe(true);
    expect(r.codigo_bloqueo).toBeNull();
    expect(r.stock_antes).toBe(110);
    expect(r.stock_despues).toBe(120);
    expect(r.salidas_afectadas).toEqual([]);
  });

  it('la ENTRADA de 1 a $350 que el FIFO no alcanzó a consumir SE PUEDE eliminar', () => {
    const r = evaluarEliminacion(CARDEX, 'E3');
    expect(r.permitido).toBe(true);
    expect(r.stock_antes).toBe(110);
    expect(r.stock_despues).toBe(109);
  });

  it('la SALIDA intermedia de 1 SE PUEDE eliminar: las capas de $0 no mueven ningún costo', () => {
    const r = evaluarEliminacion(CARDEX, 'S4');
    expect(r.permitido).toBe(true);
    expect(r.stock_despues).toBe(111);
    expect(r.salidas_afectadas).toEqual([]);
  });

  it('la ENTRADA de 120 NO se puede: la salida de 1 se quedaría sin existencia (y el mensaje dice cuál borrar primero)', () => {
    const r = evaluarEliminacion(CARDEX, 'E2');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('STOCK_NEGATIVO');
    expect(r.stock_despues).toBe(-10);
    expect(r.detalle).toContain('elimina primero');
    expect(r.detalle).toContain('SALIDA de 1 del 29 ago 2026 a XA-VGV');
  });

  it('la SALIDA de 24 NO se puede: movería el costo FIFO de las salidas del 29-ago (de $0 a $1,658.33)', () => {
    const r = evaluarEliminacion(CARDEX, 'S3');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('CAMBIA_COSTO_FIFO');
    expect(r.salidas_afectadas.map((s) => s.id)).toEqual(['S4', 'S5']);
    expect(r.salidas_afectadas[0]).toMatchObject({
      id: 'S4',
      fecha: '2026-08-29',
      costo_antes: 0,
      costo_despues: 1658.33,
      costo_antes_usd: 0,
      costo_despues_usd: 94.71,
    });
    expect(r.detalle).toContain('ya se cargó al avión');
  });

  it('la ENTRADA original de 30 NO se puede: la primera salida quedaría en negativo', () => {
    const r = evaluarEliminacion(CARDEX, 'E1');
    expect(r.codigo_bloqueo).toBe('STOCK_NEGATIVO');
    expect(r.detalle).toContain('SALIDA de 4 del 17 jul 2026 a N4142R');
  });

  it('borrar de la más nueva a la más vieja SÍ funciona (S5 → E3 → S4)', () => {
    const sinS5 = CARDEX.filter((x) => x.id !== 'S5');
    expect(evaluarEliminacion(sinS5, 'E3').permitido).toBe(true);
    const sinE3 = sinS5.filter((x) => x.id !== 'E3');
    expect(evaluarEliminacion(sinE3, 'S4').permitido).toBe(true);
    const sinS4 = sinE3.filter((x) => x.id !== 'S4');
    // Con las tres capturas del 29-ago fuera, la ENTRADA de 120 ya se va.
    const r = evaluarEliminacion(sinS4, 'E2');
    expect(r.permitido).toBe(true);
    expect(r.stock_antes).toBe(120);
    expect(r.stock_despues).toBe(0);
  });
});

describe('evaluarEliminacion · capas con costo DISTINTO', () => {
  const A = m({
    id: 'A',
    tipo: 'ENTRADA',
    cantidad: 5,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    ...enPesos(100, 20),
  });
  const B = m({
    id: 'B',
    tipo: 'ENTRADA',
    cantidad: 5,
    fecha_movimiento: '2026-09-02',
    created_at: '2026-09-02T10:00:00Z',
    ...enPesos(200, 20),
  });
  const S = m({
    id: 'S',
    tipo: 'SALIDA',
    cantidad: 5,
    fecha_movimiento: '2026-09-03',
    created_at: '2026-09-03T10:00:00Z',
    aeronave_matricula: 'XA-VGV',
  });

  it('la capa VIEJA (ya consumida) se bloquea: la salida pasaría de $500 a $1,000', () => {
    const r = evaluarEliminacion([A, B, S], 'A');
    expect(r.codigo_bloqueo).toBe('CAMBIA_COSTO_FIFO');
    expect(r.salidas_afectadas).toEqual([
      {
        id: 'S',
        fecha: '2026-09-03',
        costo_antes: 500,
        costo_despues: 1000,
        costo_antes_usd: 25,
        costo_despues_usd: 50,
      },
    ]);
    expect(r.detalle).toContain('$500.00 MXN');
    expect(r.detalle).toContain('$1,000.00 MXN');
  });

  it('la capa NUEVA (intacta) se permite: ninguna salida cambia de costo', () => {
    const r = evaluarEliminacion([A, B, S], 'B');
    expect(r.permitido).toBe(true);
    expect(r.stock_antes).toBe(5);
    expect(r.stock_despues).toBe(0);
  });

  it('la SALIDA se permite aunque haya capas distintas: no hay nadie después', () => {
    expect(evaluarEliminacion([A, B, S], 'S').permitido).toBe(true);
  });
});

/**
 * REVISIÓN ADVERSARIA (21-sep-2026). Verificado contra producción: 66 de los
 * 75 movimientos del cardex son capturas en USD SIN tipo de cambio y con
 * costo > 0 (la carga VTF-INV-001 completada con el PATCH de costo). Para
 * esas capas `walkCardex` NO puede expresar el costo en pesos y devuelve
 * `costoMxnFifo: null`. Comparando SOLO los pesos, «null vs null» se leía
 * como «el costo no cambió» y la baja pasaba — aunque el costo REAL de la
 * salida saltara de $46.06 a $9,541.25 USD. El candado mira las DOS monedas.
 */
describe('evaluarEliminacion · capas USD SIN tipo de cambio (forma de prod)', () => {
  const usd = (n: number) => ({
    moneda: 'USD',
    costo_unitario_usd: n,
    costo_unitario_mxn: null,
    tc_usd_mxn: null,
  });
  const BARATA = m({
    id: 'BARATA',
    tipo: 'ENTRADA',
    cantidad: 1,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    ...usd(46.06),
  });
  const CARA = m({
    id: 'CARA',
    tipo: 'ENTRADA',
    cantidad: 3,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T11:00:00Z',
    ...usd(9541.25),
  });
  const SAL = m({
    id: 'SAL',
    tipo: 'SALIDA',
    cantidad: 1,
    fecha_movimiento: '2026-09-02',
    created_at: '2026-09-02T10:00:00Z',
    aeronave_matricula: 'XA-VGV',
    ...usd(46.06),
  });

  it('borrar la capa YA CONSUMIDA se bloquea aunque el costo en pesos sea null en los dos lados', () => {
    const r = evaluarEliminacion([BARATA, CARA, SAL], 'BARATA');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('CAMBIA_COSTO_FIFO');
    expect(r.salidas_afectadas).toEqual([
      {
        id: 'SAL',
        fecha: '2026-09-02',
        costo_antes: null,
        costo_despues: null,
        costo_antes_usd: 46.06,
        costo_despues_usd: 9541.25,
      },
    ]);
    // El mensaje NO puede decir «$0.00 MXN» ni «null»: dice el número real.
    expect(r.detalle).toContain('$46.06 USD');
    expect(r.detalle).toContain('$9,541.25 USD');
  });

  it('la capa INTACTA sigue siendo eliminable (el candado no se volvió paranoico)', () => {
    const r = evaluarEliminacion([BARATA, CARA, SAL], 'CARA');
    expect(r.permitido).toBe(true);
    expect(r.stock_antes).toBe(3);
    expect(r.stock_despues).toBe(0);
  });

  it('capas de $0 (la ENTRADA de 120 del caso real) siguen permitiendo la baja', () => {
    // Sin costo no hay costo que mover: el candado no debe inventar bloqueos.
    expect(evaluarEliminacion(CARDEX, 'S4').permitido).toBe(true);
    expect(evaluarEliminacion(CARDEX, 'S5').permitido).toBe(true);
  });
});

describe('evaluarEliminacion · tipos y errores', () => {
  const base = m({
    id: 'E',
    tipo: 'ENTRADA',
    cantidad: 10,
    fecha_movimiento: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    ...enPesos(100, 20),
  });

  it('DEVOLUCION y AJUSTE quedan fuera de esta versión', () => {
    for (const tipo of ['DEVOLUCION', 'AJUSTE']) {
      const mov = m({
        id: 'X',
        tipo,
        cantidad: 2,
        fecha_movimiento: '2026-09-02',
        created_at: '2026-09-02T10:00:00Z',
        ...enPesos(100, 20),
      });
      const r = evaluarEliminacion([base, mov], 'X');
      expect(r.permitido).toBe(false);
      expect(r.codigo_bloqueo).toBe('TIPO_NO_SOPORTADO');
      expect(r.detalle).toContain('movimiento contrario');
    }
  });

  it('un movimiento que no está en el cardex revienta (error de programación, no 409)', () => {
    expect(() => evaluarEliminacion([base], 'no-existe')).toThrow(
      /no está en el cardex/,
    );
  });

  it('un cardex de un solo movimiento se puede vaciar', () => {
    const r = evaluarEliminacion([base], 'E');
    expect(r.permitido).toBe(true);
    expect(r.stock_antes).toBe(10);
    expect(r.stock_despues).toBe(0);
  });
});

describe('texto es-MX (determinista, sin locale ni Date)', () => {
  it('fechaCardexEsMx corta el string: nunca resta un día en Cancún', () => {
    expect(fechaCardexEsMx('2026-08-29')).toBe('29 ago 2026');
    expect(fechaCardexEsMx('2026-01-01')).toBe('1 ene 2026');
    expect(fechaCardexEsMx('vacío')).toBe('vacío');
  });

  it('montoTxt agrupa miles con punto decimal', () => {
    expect(montoTxt(6633.32)).toBe('$6,633.32');
    expect(montoTxt(0)).toBe('$0.00');
    expect(montoTxt(1234567.5)).toBe('$1,234,567.50');
  });

  it('cantidadTxt no rellena con ceros', () => {
    expect(cantidadTxt(10)).toBe('10');
    expect(cantidadTxt('2.50')).toBe('2.5');
    expect(cantidadTxt(2.375)).toBe('2.38');
  });

  it('describirMovimiento nombra el destino de una salida', () => {
    expect(describirMovimiento(S5)).toBe(
      'la SALIDA de 10 del 29 ago 2026 a XA-VGV',
    );
    expect(describirMovimiento(E1)).toBe('la ENTRADA de 30 del 13 jul 2026');
    expect(
      describirMovimiento({
        ...S5,
        aeronave_matricula: null,
        para_flota: true,
      }),
    ).toBe('la SALIDA de 10 del 29 ago 2026 a toda la flota');
  });
});

describe('errores de la función de BD', () => {
  it('reconoce los códigos conocidos y separa el texto', () => {
    const msg =
      'MOVIMIENTO_DE_COMPRA: esta entrada nace de la compra #3; quítala o corrígela desde Compras.';
    expect(codigoDeErrorEliminacion(msg)).toBe('MOVIMIENTO_DE_COMPRA');
    expect(mensajeDeErrorEliminacion(msg)).toBe(
      'esta entrada nace de la compra #3; quítala o corrígela desde Compras.',
    );
    expect(codigoDeErrorEliminacion('GASTO_BLOQUEADO: x')).toBe(
      'GASTO_BLOQUEADO',
    );
    expect(codigoDeErrorEliminacion('MOTIVO_REQUERIDO: corto')).toBe(
      'MOTIVO_REQUERIDO',
    );
  });

  it('un error de BD cualquiera NO se convierte en 409 inventado', () => {
    expect(codigoDeErrorEliminacion('deadlock detected')).toBeNull();
    expect(
      codigoDeErrorEliminacion('OTRA_COSA: no está en la lista'),
    ).toBeNull();
    expect(codigoDeErrorEliminacion(null)).toBeNull();
    expect(mensajeDeErrorEliminacion('deadlock detected')).toBe(
      'deadlock detected',
    );
  });

  it('esTablaInexistente distingue «falta la migración» de cualquier otro error', () => {
    expect(esTablaInexistente({ code: '42P01', message: 'x' })).toBe(true);
    expect(esTablaInexistente({ code: 'PGRST205', message: 'x' })).toBe(true);
    expect(
      esTablaInexistente({
        code: null,
        message:
          "Could not find the table 'public.inventario_movimiento_eliminado' in the schema cache",
      }),
    ).toBe(true);
    expect(esTablaInexistente({ code: '42501', message: 'denied' })).toBe(
      false,
    );
    expect(esTablaInexistente(null)).toBe(false);
  });
});
