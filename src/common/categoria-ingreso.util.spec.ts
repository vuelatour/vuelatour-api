import {
  CATEGORIAS_INGRESO,
  CATEGORIAS_INGRESO_RESULTADO,
  CATEGORIA_INGRESO_AYUDA,
  CATEGORIA_INGRESO_DESTINO,
  CATEGORIA_INGRESO_LABEL,
  DESTINO_INGRESO_RESULTADO,
  categoriaIngresoAdmiteAvion,
  categoriaIngresoAdmiteVuelo,
  categoriaIngresoExigeCliente,
  categoriaIngresoSumaAResultados,
  categoriaSugeridaDeDescripcion,
  destinoIngreso,
  destinoIngresoAvion,
  esAnticipo,
  esCategoriaIngreso,
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
  textoDestinoIngreso,
} from './categoria-ingreso.util';

/**
 * TABLA LITERAL de las categorías de ingreso (contrato §2). El panel copia
 * esta tabla byte por byte en `src/lib/admin/categorias-ingreso.ts` con los
 * MISMOS nombres de export: si cambias un texto aquí, cámbialo allá (y su
 * test lo congela igual).
 */
const TABLA = [
  [
    'OTRO_INGRESO',
    'Otros ingresos',
    'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
    'Dinero que entra y no es de un vuelo ni de otra categoría. Si es el pago de un vuelo, regístralo como cobro en el vuelo.',
  ],
  [
    'ANTICIPO_CLIENTE',
    'Anticipos y depósitos de clientes',
    'Fuera de resultados hasta aplicarse a un vuelo (ahí cuenta como cobro del vuelo)',
    'El cliente pagó y su vuelo todavía no existe. Si el vuelo ya existe, registra el cobro en el vuelo.',
  ],
  [
    'INGRESO_BANCARIO',
    'Ingresos en cuentas de banco',
    'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
    'Intereses, rendimientos y bonificaciones del banco.',
  ],
  [
    'REEMBOLSO_DEVOLUCION',
    'Reembolsos y devoluciones recibidos',
    'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
    'Dinero que nos regresan: aseguradoras, gastos médicos, devoluciones de proveedores. (Si tú le devuelves dinero a un cliente, eso es un reembolso en el vuelo, no un ingreso.)',
  ],
  [
    'VENTA_ACTIVO',
    'Venta de refacciones o activos a terceros',
    'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
    'Venta de piezas, equipo o activos a alguien de fuera. Si la pieza sale de bodega, registra también la salida en Inventario.',
  ],
  [
    'APORTACION_PRESTAMO',
    'Aportaciones de socios y préstamos',
    'Fuera de resultados (no es venta: es capital o deuda)',
    'Dinero que ponen los socios o un préstamo recibido.',
  ],
] as const;

describe('categoria-ingreso.util — tabla canónica (contrato §2)', () => {
  it('códigos en el orden de los selectores', () => {
    expect([...CATEGORIAS_INGRESO]).toEqual(TABLA.map((f) => f[0]));
  });

  it('etiquetas, destinos y ayudas LITERALES', () => {
    for (const [codigo, etiqueta, destino, ayuda] of TABLA) {
      expect(CATEGORIA_INGRESO_LABEL[codigo]).toBe(etiqueta);
      expect(CATEGORIA_INGRESO_DESTINO[codigo]).toBe(destino);
      expect(CATEGORIA_INGRESO_AYUDA[codigo]).toBe(ayuda);
    }
    expect(Object.keys(CATEGORIA_INGRESO_LABEL)).toHaveLength(6);
    expect(DESTINO_INGRESO_RESULTADO).toBe(
      'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
    );
  });

  it('ningún texto dice «Otros ingresos VuelaTour» (choca con el bloque de TUAs/extras)', () => {
    for (const c of CATEGORIAS_INGRESO) {
      expect(CATEGORIA_INGRESO_LABEL[c]).not.toMatch(
        /Otros ingresos VuelaTour/,
      );
      expect(CATEGORIA_INGRESO_DESTINO[c]).not.toMatch(
        /Otros ingresos VuelaTour/,
      );
    }
  });

  it('membresía EXACTA de las que suman a resultados (cambiar un destino mueve dinero)', () => {
    expect([...CATEGORIAS_INGRESO_RESULTADO].sort()).toEqual(
      [
        'INGRESO_BANCARIO',
        'OTRO_INGRESO',
        'REEMBOLSO_DEVOLUCION',
        'VENTA_ACTIVO',
      ].sort(),
    );
    expect(categoriaIngresoSumaAResultados('OTRO_INGRESO')).toBe(true);
    expect(categoriaIngresoSumaAResultados('ANTICIPO_CLIENTE')).toBe(false);
    expect(categoriaIngresoSumaAResultados('APORTACION_PRESTAMO')).toBe(false);
    expect(categoriaIngresoSumaAResultados(null)).toBe(false);
    expect(categoriaIngresoSumaAResultados('XXX')).toBe(false);
  });

  it('cliente solo en anticipo; vuelo solo en reembolsos recibidos (espejo de los CHECK)', () => {
    for (const c of CATEGORIAS_INGRESO) {
      expect(categoriaIngresoExigeCliente(c)).toBe(c === 'ANTICIPO_CLIENTE');
      expect(esAnticipo(c)).toBe(c === 'ANTICIPO_CLIENTE');
      expect(categoriaIngresoAdmiteVuelo(c)).toBe(c === 'REEMBOLSO_DEVOLUCION');
    }
    expect(esCategoriaIngreso('VENTA_ACTIVO')).toBe(true);
    expect(esCategoriaIngreso('COBRO_VUELO')).toBe(false);
  });

  it('etiquetas: fallback capitalizado, vacío y folio ING-n', () => {
    expect(etiquetaCategoriaIngreso('INGRESO_BANCARIO')).toBe(
      'Ingresos en cuentas de banco',
    );
    expect(etiquetaCategoriaIngreso('ALGO_NUEVO')).toBe('Algo nuevo');
    expect(etiquetaCategoriaIngreso(null)).toBe('');
    expect(etiquetaCategoriaIngreso('')).toBe('');
    expect(etiquetaIngreso(12)).toBe('ING-12');
    expect(etiquetaIngreso(null)).toBe('ING-?');
  });
});

describe('categoriaSugeridaDeDescripcion — descripciones REALES de prod (24-sep)', () => {
  it.each([
    ['Rembolso Gastos Medicos Dani', 'REEMBOLSO_DEVOLUCION'],
    ['Transf Interbancaria SPEI reembolso', 'REEMBOLSO_DEVOLUCION'],
    ['DEVOLUCIÓN PROVEEDOR ASA', 'REEMBOLSO_DEVOLUCION'],
    ['PAGO ASEGURADORA GNP', 'REEMBOLSO_DEVOLUCION'],
    ['INTERESES GANADOS', 'INGRESO_BANCARIO'],
    ['Rendimiento inversión', 'INGRESO_BANCARIO'],
    ['APORTACIÓN SOCIO', 'APORTACION_PRESTAMO'],
    ['Préstamo recibido', 'APORTACION_PRESTAMO'],
  ])('«%s» ⇒ %s', (desc, esperado) => {
    expect(categoriaSugeridaDeDescripcion(desc)).toBe(esperado);
  });

  it.each([
    'LETICIA LEON ALVARADO : PAGO',
    'MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola',
    'POCKET DE LATINOAMERICA SAPI DE CV : Deposito BPU3749203459',
    'SEL TRASPASO ENTRE CUENTAS',
    'Rev ASUR Merida',
    '',
  ])('«%s» ⇒ null (el pago de un cliente se decide a mano)', (desc) => {
    expect(categoriaSugeridaDeDescripcion(desc)).toBeNull();
  });

  it('nunca propone OTRO_INGRESO ni ANTICIPO_CLIENTE', () => {
    const muestras = [
      'PAGO VUELO',
      'ANTICIPO CLIENTE',
      'DEPOSITO',
      'OTRO INGRESO',
      null,
    ];
    for (const m of muestras) {
      const r = categoriaSugeridaDeDescripcion(m);
      expect(r).not.toBe('OTRO_INGRESO');
      expect(r).not.toBe('ANTICIPO_CLIENTE');
    }
  });
});

/**
 * INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67). El
 * panel copia los 5 exports con los MISMOS nombres y textos
 * (`src/lib/admin/__tests__/categorias-ingreso.test.ts` congela los mismos
 * casos literales).
 */
describe('ingreso asignado a un avión — destino (invariante 67)', () => {
  const AV = 'av-n990gg';

  it('categoriaIngresoAdmiteAvion ≡ suma a resultados (membresía congelada: 4 sí, 2 no)', () => {
    for (const c of [
      'OTRO_INGRESO',
      'INGRESO_BANCARIO',
      'REEMBOLSO_DEVOLUCION',
      'VENTA_ACTIVO',
    ]) {
      expect(categoriaIngresoAdmiteAvion(c)).toBe(true);
    }
    for (const c of ['ANTICIPO_CLIENTE', 'APORTACION_PRESTAMO', null, 'XXX']) {
      expect(categoriaIngresoAdmiteAvion(c)).toBe(false);
    }
    expect(categoriaIngresoAdmiteAvion(undefined)).toBe(false);
    for (const c of CATEGORIAS_INGRESO) {
      expect(categoriaIngresoAdmiteAvion(c)).toBe(
        categoriaIngresoSumaAResultados(c),
      );
    }
  });

  it('destinoIngreso en sus 3 ramas', () => {
    expect(destinoIngreso('REEMBOLSO_DEVOLUCION', AV)).toBe('AVION');
    expect(destinoIngreso('INGRESO_BANCARIO', null)).toBe('VUELATOUR');
    expect(destinoIngreso('OTRO_INGRESO', '')).toBe('VUELATOUR');
    expect(destinoIngreso('ANTICIPO_CLIENTE', AV)).toBe('FUERA_DE_RESULTADOS');
    expect(destinoIngreso('APORTACION_PRESTAMO', null)).toBe(
      'FUERA_DE_RESULTADOS',
    );
    expect(destinoIngreso(null, AV)).toBe('FUERA_DE_RESULTADOS');
  });

  it('destinoIngresoAvion: con matrícula (recortada) y sin ella, LITERALES', () => {
    expect(destinoIngresoAvion('N990GG')).toBe(
      'Otros ingresos del avión N990GG (balance del avión y reparto a socios)',
    );
    expect(destinoIngresoAvion('  N990GG ')).toBe(
      'Otros ingresos del avión N990GG (balance del avión y reparto a socios)',
    );
    for (const m of [null, undefined, '', '  ']) {
      expect(destinoIngresoAvion(m)).toBe(
        'Otros ingresos del avión (balance del avión y reparto a socios)',
      );
    }
  });

  it('textoDestinoIngreso: con avión el del avión; si no, la tabla congelada', () => {
    expect(textoDestinoIngreso('REEMBOLSO_DEVOLUCION', AV, 'N990GG')).toBe(
      'Otros ingresos del avión N990GG (balance del avión y reparto a socios)',
    );
    expect(textoDestinoIngreso('VENTA_ACTIVO', AV)).toBe(
      'Otros ingresos del avión (balance del avión y reparto a socios)',
    );
    // Un anticipo con avión (dato legado) dice SU destino: no cuenta al avión.
    expect(textoDestinoIngreso('ANTICIPO_CLIENTE', AV, 'N990GG')).toBe(
      CATEGORIA_INGRESO_DESTINO.ANTICIPO_CLIENTE,
    );
    expect(textoDestinoIngreso('OTRO_INGRESO', null, 'N990GG')).toBe(
      DESTINO_INGRESO_RESULTADO,
    );
    expect(textoDestinoIngreso('XXX', null)).toBe('');
    expect(textoDestinoIngreso(null, AV, 'N990GG')).toBe('');
  });

  it('ningún texto nuevo dice «Otros ingresos VuelaTour» y las tablas siguen intactas', () => {
    const nuevos = [
      destinoIngresoAvion('N990GG'),
      destinoIngresoAvion(null),
      ...CATEGORIAS_INGRESO.map((c) => textoDestinoIngreso(c, AV, 'N990GG')),
      ...CATEGORIAS_INGRESO.map((c) => textoDestinoIngreso(c, null)),
    ];
    for (const t of nuevos) expect(t).not.toMatch(/Otros ingresos VuelaTour/);
    for (const [codigo, etiqueta, destino, ayuda] of TABLA) {
      expect(CATEGORIA_INGRESO_LABEL[codigo]).toBe(etiqueta);
      expect(CATEGORIA_INGRESO_DESTINO[codigo]).toBe(destino);
      expect(CATEGORIA_INGRESO_AYUDA[codigo]).toBe(ayuda);
    }
  });
});
