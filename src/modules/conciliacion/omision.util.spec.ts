import {
  CLASIFICACION_OMITIDO,
  COLUMNAS_TRIGGER_OMITIDO,
  esClasificacionOmitida,
  estadoMovimientoParaOmitir,
  etiquetaOmisionReporte,
  leerErrorOmision,
  leerOmision,
  lineaMovimientoMensaje,
  lineaOmision,
  LINEA_OMISION_MAX,
  mensajeMovimientoOmitido,
  mensajeMovimientosNoExisten,
  mensajeNoOmitidos,
  mensajeNoPendientes,
  mensajeOmitirConRiesgo,
  MENSAJE_OPCION_NO_ACTIVA,
  OMISION_SIN_DATOS,
  omisionDeFila,
  PREFIJO_LINEA_OMISION,
  PRIORIDAD_RIESGO_OMISION,
  quitarLineaOmision,
  riesgoDeOmision,
  textoConciliadosReporte,
  textoEstadoNoPendiente,
  textoOmitidosPreCierre,
  textoRiesgoOmision,
} from './omision.util';

/**
 * «OMITIR LA CONCILIACIÓN» (14-oct-2026, API 0.0.77, invariante 75): la
 * regla y los textos PUROS. Los espejos con la migración los congela
 * `omision-cargos.paridad.spec.ts`.
 */
describe('omision.util — clasificación canónica', () => {
  it('reconoce el nombre sin distinguir mayúsculas ni espacios de más', () => {
    expect(esClasificacionOmitida('Omitido de la conciliación')).toBe(true);
    expect(esClasificacionOmitida('  OMITIDO   de la   CONCILIACIÓN ')).toBe(
      true,
    );
    expect(esClasificacionOmitida('omitido de la conciliación\n')).toBe(true);
  });

  it('los acentos cuentan (como `lower()` de la BD) y otro nombre no es', () => {
    expect(esClasificacionOmitida('Omitido de la conciliacion')).toBe(false);
    expect(esClasificacionOmitida('Traspaso entre cuentas')).toBe(false);
    expect(esClasificacionOmitida('Omitido')).toBe(false);
    expect(esClasificacionOmitida(null)).toBe(false);
    expect(esClasificacionOmitida(undefined)).toBe(false);
  });

  it('el prefijo de la línea es el nombre + «: »', () => {
    expect(PREFIJO_LINEA_OMISION).toBe(`${CLASIFICACION_OMITIDO}: `);
    expect(COLUMNAS_TRIGGER_OMITIDO).toHaveLength(7);
  });
});

describe('omision.util — la línea firmada', () => {
  it('arma la línea exacta con el día Cancún', () => {
    expect(
      lineaOmision({
        motivo: 'Comisión o IVA del banco',
        usuario: 'Alejandro Canales',
        hoy: '2026-10-14',
      }),
    ).toBe(
      'Omitido de la conciliación: Comisión o IVA del banco — Alejandro Canales, 14-oct-2026',
    );
  });

  it('colapsa saltos y espacios del motivo y del firmante; sin firmante ⇒ «Oficina»', () => {
    expect(
      lineaOmision({
        motivo: '  Cargo   duplicado\npor el banco\r\n ',
        usuario: '   ',
        hoy: '2026-09-01',
      }),
    ).toBe(
      'Omitido de la conciliación: Cargo duplicado por el banco — Oficina, 01-sep-2026',
    );
    expect(
      lineaOmision({
        motivo: 'Motivo suficiente',
        usuario: null,
        hoy: '2026-09-01',
      }),
    ).toContain('— Oficina, 01-sep-2026');
  });

  it('recorta el motivo a 300 y nunca pasa de 500 ni trae saltos', () => {
    const l = lineaOmision({
      motivo: 'x'.repeat(400),
      usuario: 'y'.repeat(200),
      hoy: '2026-10-14',
    });
    expect(l.length).toBeLessThanOrEqual(LINEA_OMISION_MAX);
    expect(l).not.toMatch(/[\r\n]/);
    const leida = leerOmision(l);
    expect(leida?.motivo).toBe('x'.repeat(300));
    expect(leida?.por).toBe('y'.repeat(80));
    expect(leida?.fecha).toBe('14-oct-2026');
  });

  it('ida y vuelta: leer la línea devuelve motivo, quién y fecha', () => {
    const l = lineaOmision({
      motivo: 'Pago de la tarjeta — corte de septiembre',
      usuario: 'Mary Cruz',
      hoy: '2026-10-14',
    });
    // El motivo puede traer « — »: se parte por la ÚLTIMA.
    expect(leerOmision(`${l}\nNota del banco`)).toEqual({
      motivo: 'Pago de la tarjeta — corte de septiembre',
      por: 'Mary Cruz',
      fecha: '14-oct-2026',
    });
  });
});

describe('omision.util — leerOmision / omisionDeFila', () => {
  it('sin el prefijo en la PRIMERA línea ⇒ null', () => {
    expect(leerOmision(null)).toBeNull();
    expect(leerOmision('')).toBeNull();
    expect(
      leerOmision('Nota\nOmitido de la conciliación: algo — Ale, 14-oct-2026'),
    ).toBeNull();
  });

  it('con el prefijo pero dañada ⇒ OMISION_SIN_DATOS', () => {
    expect(leerOmision('Omitido de la conciliación: sin firma')).toEqual(
      OMISION_SIN_DATOS,
    );
    expect(
      leerOmision('Omitido de la conciliación: motivo — Ale 14-oct-2026'),
    ).toEqual(OMISION_SIN_DATOS);
    expect(
      leerOmision('Omitido de la conciliación: motivo — Ale, ayer'),
    ).toEqual(OMISION_SIN_DATOS);
    expect(
      leerOmision('Omitido de la conciliación:  — Ale, 14-oct-2026'),
    ).toEqual(OMISION_SIN_DATOS);
  });

  it('`\\r\\n` no ensucia la fecha', () => {
    expect(
      leerOmision(
        'Omitido de la conciliación: IVA — Ale, 14-oct-2026\r\nresto',
      ),
    ).toEqual({ motivo: 'IVA', por: 'Ale', fecha: '14-oct-2026' });
  });

  it('omisionDeFila exige la clasificación CANÓNICA (objeto o arreglo)', () => {
    const notas = 'Omitido de la conciliación: IVA — Ale, 14-oct-2026';
    expect(
      omisionDeFila({
        clasificacion: { nombre: CLASIFICACION_OMITIDO },
        notas,
      }),
    ).toEqual({ motivo: 'IVA', por: 'Ale', fecha: '14-oct-2026' });
    expect(
      omisionDeFila({
        clasificacion: [{ nombre: CLASIFICACION_OMITIDO }],
        notas,
      }),
    ).toEqual({ motivo: 'IVA', por: 'Ale', fecha: '14-oct-2026' });
    // Otra clasificación con la línea copiada a mano: NO es un omitido.
    expect(
      omisionDeFila({ clasificacion: { nombre: 'Comisión del banco' }, notas }),
    ).toBeNull();
    expect(omisionDeFila({ clasificacion: null, notas })).toBeNull();
    // Canónica sin línea legible: sigue siendo omitido, sin datos.
    expect(
      omisionDeFila({
        clasificacion: { nombre: CLASIFICACION_OMITIDO },
        notas: 'nota de la oficina',
      }),
    ).toEqual(OMISION_SIN_DATOS);
  });
});

describe('omision.util — quitarLineaOmision (espejo del UPDATE de la RPC)', () => {
  it.each([
    [null, null],
    ['', ''],
    ['Sin línea canónica', 'Sin línea canónica'],
    ['Omitido de la conciliación: IVA — Ale, 14-oct-2026', null],
    ['Omitido de la conciliación: IVA — Ale, 14-oct-2026\n', null],
    [
      'Omitido de la conciliación: IVA — Ale, 14-oct-2026\nNota  con  espacios \n\nfin ',
      'Nota  con  espacios \n\nfin ',
    ],
    [
      'Omitido de la conciliación: IVA — Ale, 14-oct-2026\r\nresto\r\n',
      'resto\r\n',
    ],
    // Solo la PRIMERA línea canónica (una segunda se queda: es texto).
    [
      'Omitido de la conciliación: A — X, 01-oct-2026\nOmitido de la conciliación: B — Y, 02-oct-2026',
      'Omitido de la conciliación: B — Y, 02-oct-2026',
    ],
  ])('%j ⇒ %j', (antes, despues) => {
    expect(quitarLineaOmision(antes)).toBe(despues);
  });

  it('omitir y deshacer devuelve las notas byte a byte', () => {
    const original = '  Nota de la oficina\r\ncon dos líneas  \n';
    const linea = lineaOmision({
      motivo: 'Motivo largo',
      usuario: 'Ale',
      hoy: '2026-10-14',
    });
    expect(quitarLineaOmision(`${linea}\n${original}`)).toBe(original);
  });
});

describe('omision.util — estado (espejo del CASE de la RPC)', () => {
  const ctx = { idOmitido: 'c-omit', tieneDevolucion: false };
  it.each<[Record<string, unknown>, boolean, string]>([
    [{ conciliado: false }, false, 'PENDIENTE'],
    [{}, false, 'PENDIENTE'],
    [{ conciliado: true, gasto_id: 'g' }, false, 'CON_GASTO'],
    [{ conciliado: true, gastos_n: 2 }, false, 'CON_GASTO'],
    [{ conciliado: true, cobro_id: 'c' }, false, 'CON_COBRO'],
    [{ conciliado: true, cobros_n: 2 }, false, 'CON_COBRO'],
    [{ conciliado: true, cobro_grupo_id: 's' }, false, 'CON_SOBRE'],
    [{ conciliado: true, ingreso_id: 'i' }, false, 'CON_INGRESO'],
    [{ conciliado: true, reverso_de_id: 'r' }, false, 'REVERSO'],
    [{ conciliado: true, clasificacion_id: 'x' }, true, 'REVERSO'],
    [{ conciliado: false }, true, 'REVERSO'],
    [{ conciliado: true, clasificacion_id: 'c-omit' }, false, 'OMITIDO'],
    [{ conciliado: true, clasificacion_id: 'otra' }, false, 'CLASIFICADO'],
    [{ conciliado: true }, false, 'CONCILIADO'],
    // Precedencia: gasto gana a todo lo demás.
    [
      {
        conciliado: true,
        gasto_id: 'g',
        cobro_id: 'c',
        clasificacion_id: 'c-omit',
      },
      false,
      'CON_GASTO',
    ],
  ])('%j (devolución %s) ⇒ %s', (m, dev, esperado) => {
    expect(
      estadoMovimientoParaOmitir(m, { ...ctx, tieneDevolucion: dev }),
    ).toBe(esperado);
  });

  it('sin la canónica, una clasificación es CLASIFICADO', () => {
    expect(
      estadoMovimientoParaOmitir(
        { conciliado: true, clasificacion_id: 'c-omit' },
        { idOmitido: null, tieneDevolucion: false },
      ),
    ).toBe('CLASIFICADO');
  });

  it('textos del estado', () => {
    expect(textoEstadoNoPendiente('CON_GASTO')).toBe(
      'ya está vinculado a un gasto',
    );
    expect(textoEstadoNoPendiente('OMITIDO')).toBe('ya está omitido');
    expect(textoEstadoNoPendiente('RARO')).toBe('ya no está pendiente');
    expect(textoEstadoNoPendiente(null)).toBe('ya no está pendiente');
  });
});

describe('omision.util — riesgo de omitir (falla CERRADO)', () => {
  const base = { traspaso: false, devolucion: false };
  it('CARGO: el motivo del badge decide', () => {
    expect(
      riesgoDeOmision({
        ...base,
        tipo: 'CARGO',
        motivoCargo: 'SE_PUEDE_CRUZAR',
      }),
    ).toBe('GASTO_QUE_CUADRA');
    expect(
      riesgoDeOmision({ ...base, tipo: 'CARGO', motivoCargo: 'AMBIGUO' }),
    ).toBe('GASTOS_AMBIGUOS');
    expect(
      riesgoDeOmision({
        ...base,
        tipo: 'CARGO',
        motivoCargo: 'SIN_CANDIDATOS',
      }),
    ).toBeNull();
    // Sin anotar (lectura caída, truncada o cuenta sin moneda).
    expect(riesgoDeOmision({ ...base, tipo: 'CARGO', motivoCargo: null })).toBe(
      'SIN_VERIFICAR',
    );
    expect(riesgoDeOmision({ ...base, tipo: 'CARGO' })).toBe('SIN_VERIFICAR');
  });

  it('ABONO: cobros exactos libres; null ⇒ SIN_VERIFICAR', () => {
    expect(riesgoDeOmision({ ...base, tipo: 'ABONO', cobrosExactos: 1 })).toBe(
      'COBRO_QUE_CUADRA',
    );
    expect(
      riesgoDeOmision({ ...base, tipo: 'ABONO', cobrosExactos: 0 }),
    ).toBeNull();
    expect(
      riesgoDeOmision({ ...base, tipo: 'ABONO', cobrosExactos: null }),
    ).toBe('SIN_VERIFICAR');
    expect(
      riesgoDeOmision({
        ...base,
        tipo: 'ABONO',
        cobrosExactos: 0,
        devolucion: true,
      }),
    ).toBe('DEVOLUCION');
  });

  it('traspaso en los dos tipos y la PRIORIDAD', () => {
    expect(
      riesgoDeOmision({
        tipo: 'CARGO',
        motivoCargo: 'SIN_CANDIDATOS',
        traspaso: true,
        devolucion: false,
      }),
    ).toBe('TRASPASO');
    expect(
      riesgoDeOmision({
        tipo: 'CARGO',
        motivoCargo: 'SE_PUEDE_CRUZAR',
        traspaso: true,
        devolucion: false,
      }),
    ).toBe('GASTO_QUE_CUADRA');
    expect(
      riesgoDeOmision({
        tipo: 'ABONO',
        cobrosExactos: 2,
        traspaso: true,
        devolucion: true,
      }),
    ).toBe('COBRO_QUE_CUADRA');
    expect(
      riesgoDeOmision({
        tipo: 'ABONO',
        cobrosExactos: 0,
        traspaso: true,
        devolucion: true,
      }),
    ).toBe('TRASPASO');
    // Un devolución en un CARGO no cuenta.
    expect(
      riesgoDeOmision({
        tipo: 'CARGO',
        motivoCargo: 'SIN_CANDIDATOS',
        traspaso: false,
        devolucion: true,
      }),
    ).toBeNull();
    // Tipo desconocido ⇒ no se pudo revisar.
    expect(riesgoDeOmision({ ...base, tipo: null })).toBe('SIN_VERIFICAR');
    expect(PRIORIDAD_RIESGO_OMISION).toEqual([
      'GASTO_QUE_CUADRA',
      'GASTOS_AMBIGUOS',
      'COBRO_QUE_CUADRA',
      'TRASPASO',
      'DEVOLUCION',
      'SIN_VERIFICAR',
    ]);
  });

  it('textos del riesgo', () => {
    expect(textoRiesgoOmision('GASTO_QUE_CUADRA')).toBe(
      'hay un gasto que cuadra: «Cruzar pendientes» o «Vincular gasto» lo resuelven',
    );
    expect(textoRiesgoOmision('GASTOS_AMBIGUOS', 3)).toBe(
      'hay 3 gastos que cuadran: vincúlalo a mano',
    );
    expect(textoRiesgoOmision('GASTOS_AMBIGUOS', null)).toBe(
      'hay varios gastos que cuadran: vincúlalo a mano',
    );
    expect(textoRiesgoOmision('TRASPASO')).toBe(
      'es un traspaso entre cuentas: «Cruzar pendientes» lo clasifica solo',
    );
    expect(textoRiesgoOmision('SIN_VERIFICAR')).toBe(
      'no se pudo revisar si tiene un gasto o un cobro que cuadre',
    );
  });
});

describe('omision.util — mensajes de los 409 (textos exactos del contrato)', () => {
  const asa = {
    fecha: '2026-10-12',
    descripcion: 'ASA CANCUN',
    monto: 8468.91,
    moneda: 'MXN',
    estado: 'CON_GASTO',
  };
  const iva = {
    fecha: '2026-09-24',
    descripcion: 'IVA - COMISIONES',
    monto: 1.12,
    moneda: 'MXN',
    estado: 'OMITIDO',
  };

  it('MOVIMIENTO_NO_PENDIENTE al omitir (varios y uno)', () => {
    expect(mensajeNoPendientes([asa, iva], 12, 'omitir')).toBe(
      'No se omitió ninguno: 2 de los 12 movimientos ya no están pendientes — 12 oct · ASA CANCUN $8,468.91 (ya está vinculado a un gasto) · 24 sep · IVA - COMISIONES $1.12 (ya está omitido). Recarga la lista y vuelve a seleccionar.',
    );
    expect(mensajeNoPendientes([iva], 1, 'omitir')).toBe(
      'No se omitió: el movimiento ya no está pendiente — 24 sep · IVA - COMISIONES $1.12 (ya está omitido). Recarga la lista y vuelve a seleccionar.',
    );
  });

  it('MOVIMIENTO_NO_PENDIENTE al vincular y al crear por la suma', () => {
    const cargo = { ...asa, fecha: '2026-08-10', monto: 3216.27 };
    expect(mensajeNoPendientes([cargo], 3, 'vincular')).toBe(
      'No se vinculó ningún cargo: 1 de los 3 ya no está pendiente — 10 ago · ASA CANCUN $3,216.27 (ya está vinculado a un gasto). Quítalo de la selección y vuelve a intentarlo.',
    );
    expect(mensajeNoPendientes([cargo], 3, 'crear')).toBe(
      'No se registró el gasto: 1 de los 3 cargos ya no está pendiente — 10 ago · ASA CANCUN $3,216.27 (ya está vinculado a un gasto). Cancela, quita esos cargos de la selección y vuelve a intentarlo.',
    );
  });

  it('más de 5 se resumen con «y N más»; USD lleva su moneda; descripción ≤ 40', () => {
    const filas = Array.from({ length: 7 }, (_, i) => ({
      fecha: '2026-10-01',
      descripcion: `CARGO ${i + 1}`,
      monto: 10,
      moneda: 'USD',
      estado: 'CLASIFICADO',
    }));
    const m = mensajeNoPendientes(filas, 9, 'omitir');
    expect(m).toContain('CARGO 5 $10.00 USD (ya está clasificado) y 2 más.');
    expect(m).not.toContain('CARGO 6');
    expect(
      lineaMovimientoMensaje({
        fecha: '2026-10-01',
        descripcion: 'X'.repeat(60),
        monto: 1,
        moneda: 'MXN',
      }),
    ).toBe(`01 oct · ${'X'.repeat(39)}… $1.00`);
  });

  it('OMITIR_CON_RIESGO', () => {
    expect(
      mensajeOmitirConRiesgo(
        [
          {
            fecha: '2026-08-10',
            descripcion: 'ASA CANCUN',
            monto: 3216.27,
            moneda: 'MXN',
            riesgo: 'GASTO_QUE_CUADRA',
          },
          {
            fecha: '2026-07-17',
            descripcion: 'SEL TRASPASO ENTRE CUENTAS',
            monto: 40000,
            moneda: 'MXN',
            riesgo: 'TRASPASO',
          },
        ],
        12,
      ),
    ).toBe(
      '2 de los 12 movimientos podrían conciliarse de verdad: 10 ago · ASA CANCUN $3,216.27 (hay un gasto que cuadra: «Cruzar pendientes» o «Vincular gasto» lo resuelven) · 17 jul · SEL TRASPASO ENTRE CUENTAS $40,000.00 (es un traspaso entre cuentas: «Cruzar pendientes» lo clasifica solo). Quítalos de la selección o confirma que también se omiten.',
    );
  });

  it('MOVIMIENTO_NO_OMITIDO, MOVIMIENTO_NO_EXISTE y MOVIMIENTO_OMITIDO', () => {
    expect(mensajeNoOmitidos([iva], 3)).toBe(
      'No se restauró ninguno: 1 de los 3 ya no está omitido (24 sep · IVA - COMISIONES $1.12). Recarga la lista.',
    );
    expect(mensajeMovimientosNoExisten(2)).toBe(
      '2 de los movimientos ya no existen: recarga la página.',
    );
    expect(mensajeMovimientosNoExisten(1)).toBe(
      'Uno de los movimientos ya no existe: recarga la página.',
    );
    expect(
      mensajeMovimientoOmitido({
        motivo: 'Comisión o IVA del banco',
        por: 'Ale',
        fecha: '14-oct-2026',
      }),
    ).toBe(
      'Este movimiento se omitió de la conciliación (motivo: Comisión o IVA del banco): deshaz la omisión antes de vincularlo o clasificarlo.',
    );
    expect(mensajeMovimientoOmitido(null)).toBe(
      'Este movimiento se omitió de la conciliación: deshaz la omisión antes de vincularlo o clasificarlo.',
    );
    expect(MENSAJE_OPCION_NO_ACTIVA).toBe(
      'Esta opción todavía no está activa: avisa a sistemas.',
    );
  });
});

describe('omision.util — reporte y pre-cierre', () => {
  it('«Conciliado con» y subtítulo del Excel', () => {
    expect(
      etiquetaOmisionReporte({
        motivo: 'Comisión o IVA del banco',
        por: 'Alejandro Canales',
        fecha: '14-oct-2026',
      }),
    ).toBe(
      'Omitido: Comisión o IVA del banco (Alejandro Canales, 14-oct-2026)',
    );
    expect(etiquetaOmisionReporte(OMISION_SIN_DATOS)).toBe(
      'Omitido de la conciliación',
    );
    expect(textoConciliadosReporte(386, 0)).toBe('386 conciliados');
    expect(textoConciliadosReporte(386, 1)).toBe('386 conciliados (1 omitido)');
    expect(textoConciliadosReporte(386, 14)).toBe(
      '386 conciliados (14 omitidos)',
    );
  });

  it('detalle del renglón informativo del pre-cierre', () => {
    expect(textoOmitidosPreCierre(null)).toBe(
      'No se pudo leer cuántos movimientos se omitieron.',
    );
    expect(
      textoOmitidosPreCierre({ count: 0, monto_mxn: 0, monto_usd: 0 }),
    ).toBe(
      '0 movimientos del banco se marcaron como «no se concilian» con un motivo: revisa en Conciliación → Omitidos que ninguno sea un gasto sin capturar.',
    );
    expect(
      textoOmitidosPreCierre({ count: 1, monto_mxn: 1.12, monto_usd: 0 }),
    ).toBe(
      '1 movimiento del banco se marcó como «no se concilia» con un motivo ($1.12 MXN): revisa en Conciliación → Omitidos que no sea un gasto sin capturar.',
    );
    expect(
      textoOmitidosPreCierre({ count: 3, monto_mxn: 1234.5, monto_usd: 10 }),
    ).toContain('($1,234.50 MXN + $10.00 USD)');
  });
});

describe('omision.util — errores de las RPC', () => {
  it('hint manda; prefijo de respaldo; detail JSON', () => {
    expect(
      leerErrorOmision({
        code: '23514',
        hint: 'MOVIMIENTO_NO_PENDIENTE',
        message: 'MOVIMIENTO_NO_PENDIENTE: 1 de 2',
        details: '{"movimientos":[{"id":"a"}]}',
      }),
    ).toEqual({
      codigo: 'MOVIMIENTO_NO_PENDIENTE',
      texto: '1 de 2',
      details: { movimientos: [{ id: 'a' }] },
    });
    expect(
      leerErrorOmision({
        code: '23514',
        message: 'LOTE_INVALIDO: manda de 1 a 200',
      }).codigo,
    ).toBe('LOTE_INVALIDO');
    // GET STACKED DIAGNOSTICS da '' sin hint: el prefijo lo resuelve.
    expect(
      leerErrorOmision({
        code: '23514',
        hint: '',
        message: 'OMISION_INVALIDA: x',
      }).codigo,
    ).toBe('OMISION_INVALIDA');
  });

  it('un código ajeno o un detail que no es objeto', () => {
    const r = leerErrorOmision({
      code: '23514',
      hint: 'CARGO_EXCEDIDO',
      message: 'CARGO_EXCEDIDO: x',
      details: '[1,2]',
    });
    expect(r.codigo).toBeNull();
    expect(r.details).toBeNull();
    expect(leerErrorOmision(null).codigo).toBeNull();
    expect(
      leerErrorOmision({
        code: '23514',
        hint: 'MOVIMIENTO_NO_EXISTE',
        details: '{roto',
      }).details,
    ).toBeNull();
  });
});
