import {
  abonosCandidatosDeCargo,
  anteponerNotaReverso,
  cargoLigadoConDinero,
  cargosCandidatosDeAbono,
  elegirCargoReverso,
  emparejarReversos,
  esDevolucionDeCargo,
  etiquetaConciliadoReverso,
  fechaCortaReverso,
  motivoParInvalido,
  motivoTriggerReverso,
  movimientoLibreParaReverso,
  notaAbonoReverso,
  notaCargoReverso,
  patronDevolucion,
  pistaFechaDevolucion,
  quitarNotaReverso,
  ventanaAbonoDeCargo,
  ventanaCargoDeAbono,
  type MovimientoParReverso,
  type MovimientoReverso,
} from './reverso-cruce.util';

/**
 * REVERSOS (30-sep-2026). Caso REAL de prod (GASTOS GNRAL, cuenta
 * 76a931e0…): el 21-sep el banco cobró 8 veces «ASUR CANCUN» $825.13 —uno
 * era real y ya tenía su gasto— y el 23-sep devolvió 7 con «CARGO INDEBIDO
 * 21 SEP 355xx», los 7 con la MISMA referencia. Pregunta del cliente:
 * «¿Cómo puedo conciliar los cargos reembolsados?».
 */
const CTA = '76a931e0-7c06-47c6-a574-6c7d4a698c14';
const OTRA_CTA = '0752514c-0000-4000-8000-000000000000';
const CREADO_CARGOS = '2026-09-22 21:31:37.675974+00';
const CREADO_ABONOS = '2026-09-29 20:20:37.125835+00';

/** Los 7 cargos PENDIENTES reales (el 8.º, 1263ca78…, ya tiene gasto). */
const CARGOS_REALES: MovimientoReverso[] = [
  ['9d022c9a-c191-427b-94a7-b4e6d2f9e2f3', '00000000529137612263'],
  ['4083e656-3204-424c-956b-0cc3d77d0b5d', '00000000299762254423'],
  ['5f45d94d-00bf-44ae-8cdc-fed1f57686a4', '00000000299772094424'],
  ['466f49f9-c8d6-4a3c-8e33-1a629471836b', '00000000529620012264'],
  ['2baee742-cf9f-460a-8032-2ed9d6917d6d', '00000000299821794426'],
  ['dbc329cf-7102-4141-a1db-1c1adbb0c44a', '00000000529742012265'],
  ['5196a770-b25a-4fdd-b093-b4b1a9c28115', '00000000530279612268'],
].map(([id, referencia]) => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-21',
  monto: 825.13,
  descripcion: 'ASUR CANCUN',
  referencia,
  created_at: CREADO_CARGOS,
}));

/** Las 7 devoluciones reales del 23-sep (misma referencia en las 7). */
const ABONOS_REALES: MovimientoReverso[] = [
  ['405466de-599b-4c0e-b2df-203133282530', '35552'],
  ['35d5c5eb-ebf6-4959-a22a-e5282cde329d', '35554'],
  ['e9eae31a-8fbb-49ac-a156-f3b62b808212', '35555'],
  ['c377b91a-b0dd-46e5-92a1-1d5267ed1007', '35564'],
  ['db3c10e9-f67f-4c7c-a238-83d44a8f3f3b', '35572'],
  ['52249ccb-76a7-4634-8bfb-1ccf784667fd', '35578'],
  ['eb3467a3-7d15-4a73-8ac5-7010dde4ec39', '35579'],
].map(([id, n]) => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha: '2026-09-23',
  monto: 825.13,
  descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
  referencia: '00000000001303268115',
  created_at: CREADO_ABONOS,
}));

const cargo = (
  id: string,
  fecha: string,
  extra: Partial<MovimientoReverso> = {},
): MovimientoReverso => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha,
  monto: 825.13,
  descripcion: 'ASUR CANCUN',
  created_at: `${fecha} 12:00:00+00`,
  ...extra,
});

const abono = (
  id: string,
  fecha: string,
  descripcion: string,
  extra: Partial<MovimientoReverso> = {},
): MovimientoReverso => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha,
  monto: 825.13,
  descripcion,
  created_at: `${fecha} 12:00:00+00`,
  ...extra,
});

describe('patronDevolucion / esDevolucionDeCargo', () => {
  it.each([
    ['CARGO INDEBIDO 21 SEP 35552', 'CARGO INDEBIDO'],
    ['Devolución de compra', 'DEVOLUCION'],
    ['DEVOLUCIONES SPEI', 'DEVOLUCION'],
    ['REVERSO CARGO TPV', 'REVERSO'],
    ['Contracargo aclaración 1234', 'CONTRACARGO'],
    ['ABONO POR ACLARACION 99', 'ABONO POR ACLARACION'],
    ['Abono por aclaración', 'ABONO POR ACLARACION'],
    ['RECLAMACION RESUELTA', 'RECLAMACION'],
    // Prefijo del banco que ya detectaba `patronReverso` (24-sep-2026).
    ['REV ASUR MERIDA', 'REV'],
    ['REV.DLO*DIDI PAYIN', 'REV'],
  ])('«%s» ⇒ %s', (desc, patron) => {
    expect(patronDevolucion(desc)).toBe(patron);
    expect(esDevolucionDeCargo(desc)).toBe(true);
  });

  it.each([
    'ASUR CANCUN',
    'SPEI RECIBIDO LETICIA LEON ALVARADO : PAGO',
    'SEL TRASPASO ENTRE CUENTAS',
    'REVOLVENTE',
    'PREVIO',
    'IRREVERSOS', // la palabra tiene que EMPEZAR con el patrón
    '',
    null,
    undefined,
  ])('«%s» NO es devolución', (desc) => {
    expect(patronDevolucion(desc)).toBeNull();
    expect(esDevolucionDeCargo(desc)).toBe(false);
  });
});

describe('pistaFechaDevolucion', () => {
  it('«CARGO INDEBIDO 21 SEP 35552» del 23-sep ⇒ 2026-09-21 (el número de la cola no es fecha)', () => {
    expect(
      pistaFechaDevolucion('CARGO INDEBIDO 21 SEP 35552', '2026-09-23'),
    ).toBe('2026-09-21');
  });

  it('mes largo, pegado y con acentos', () => {
    expect(pistaFechaDevolucion('Devolución 3 septiembre', '2026-09-30')).toBe(
      '2026-09-03',
    );
    expect(pistaFechaDevolucion('REVERSO 05AGO', '2026-09-01')).toBe(
      '2026-08-05',
    );
    expect(pistaFechaDevolucion('CONTRACARGO 7 SEPT', '2026-09-20')).toBe(
      '2026-09-07',
    );
  });

  it('un «28 DIC» devuelto el 5-ene es del año ANTERIOR', () => {
    expect(pistaFechaDevolucion('CARGO INDEBIDO 28 DIC', '2027-01-05')).toBe(
      '2026-12-28',
    );
  });

  it('la misma fecha de la devolución cuenta (cargo y devolución el mismo día)', () => {
    expect(pistaFechaDevolucion('DEVOLUCION 23 SEP', '2026-09-23')).toBe(
      '2026-09-23',
    );
  });

  it('día inexistente o sin «DD MES» ⇒ null', () => {
    expect(pistaFechaDevolucion('CARGO INDEBIDO 31 SEP', '2026-10-05')).toBe(
      null,
    );
    expect(pistaFechaDevolucion('CARGO INDEBIDO 35552', '2026-09-23')).toBe(
      null,
    );
    expect(pistaFechaDevolucion('DEVOLUCION 121 SEP', '2026-09-23')).toBe(null);
    expect(pistaFechaDevolucion(null, '2026-09-23')).toBe(null);
    expect(pistaFechaDevolucion('CARGO INDEBIDO 21 SEP', 'ayer')).toBe(null);
  });

  it('29 FEB: solo en año bisiesto no posterior a la devolución', () => {
    expect(pistaFechaDevolucion('DEVOLUCION 29 FEB', '2028-03-01')).toBe(
      '2028-02-29',
    );
    expect(pistaFechaDevolucion('DEVOLUCION 29 FEB', '2027-03-01')).toBe(null);
  });
});

describe('ventanas', () => {
  it('cargo de un abono: [abono − 60, abono]; abono de un cargo: [cargo, cargo + 60]', () => {
    expect(ventanaCargoDeAbono('2026-09-23')).toEqual({
      desde: '2026-07-25',
      hasta: '2026-09-23',
    });
    expect(ventanaAbonoDeCargo('2026-09-21')).toEqual({
      desde: '2026-09-21',
      hasta: '2026-11-20',
    });
  });
});

describe('cargosCandidatosDeAbono / abonosCandidatosDeCargo', () => {
  it('filtra cuenta, monto (±0.005) y ventana; nunca a sí mismo', () => {
    const a = abono('a', '2026-09-23', 'CARGO INDEBIDO 21 SEP 1');
    const cargos = [
      cargo('ok', '2026-09-21'),
      cargo('otra-cuenta', '2026-09-21', { cuenta_bancaria_id: OTRA_CTA }),
      cargo('otro-monto', '2026-09-21', { monto: 825.14 }),
      cargo('casi', '2026-09-21', { monto: 825.134 }),
      cargo('despues', '2026-09-24'),
      cargo('muy-viejo', '2026-07-24'),
      cargo('limite', '2026-07-25'),
    ];
    expect(cargosCandidatosDeAbono(a, cargos).map((c) => c.id)).toEqual([
      'ok',
      'casi',
      'limite',
    ]);
  });

  it('del lado del cargo: devoluciones primero y luego la más cercana', () => {
    const c = cargo('c', '2026-09-21');
    const abonos = [
      abono('spei', '2026-09-22', 'SPEI RECIBIDO JUAN PEREZ'),
      abono('dev-tarde', '2026-09-30', 'DEVOLUCION'),
      abono('dev', '2026-09-23', 'CARGO INDEBIDO 21 SEP 35552'),
      abono('antes', '2026-09-20', 'CARGO INDEBIDO'),
      abono('lejos', '2026-11-21', 'DEVOLUCION'),
    ];
    expect(abonosCandidatosDeCargo(c, abonos).map((a) => a.id)).toEqual([
      'dev',
      'dev-tarde',
      'spei',
    ]);
  });
});

describe('elegirCargoReverso', () => {
  it('pista de fecha manda sobre un cargo de otro día', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'CARGO INDEBIDO 21 SEP 35552'),
      [cargo('c10', '2026-09-10'), cargo('c21', '2026-09-21')],
    );
    expect(d).toMatchObject({
      resultado: 'EMPAREJADO',
      cargo_id: 'c21',
      pista_fecha: '2026-09-21',
      candidatos_n: 2,
    });
    expect(d.motivo).toBe(
      'Devuelve el cargo del 21-09 (fecha indicada por el banco).',
    );
  });

  it('sin cargo EXACTO de la fecha: ±3 días (la fecha de aplicación del banco puede diferir)', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-25', 'CARGO INDEBIDO 21 SEP'),
      [cargo('c22', '2026-09-22'), cargo('c10', '2026-09-10')],
    );
    expect(d).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c22' });
  });

  it('con pista y NINGÚN cargo cerca ⇒ SIN_CANDIDATO (jamás otra fecha «por si acaso»)', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'CARGO INDEBIDO 21 SEP'),
      [cargo('c10', '2026-09-10')],
    );
    expect(d.resultado).toBe('SIN_CANDIDATO');
    expect(d.cargo_id).toBeNull();
    expect(d.motivo).toBe(
      'El banco indica un cargo del 21-09 y no hay uno pendiente por $825.13 en esa fecha.',
    );
  });

  it('sin pista: único candidato ⇒ se empareja', () => {
    const d = elegirCargoReverso(abono('a', '2026-09-23', 'DEVOLUCION'), [
      cargo('c', '2026-09-02'),
    ]);
    expect(d).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c' });
    expect(d.motivo).toContain('único cargo pendiente con ese monto');
  });

  it('sin pista: cargos IDÉNTICOS del mismo día ⇒ el más antiguo', () => {
    const d = elegirCargoReverso(abono('dev', '2026-09-23', 'DEVOLUCION'), [
      cargo('c2', '2026-09-21', { created_at: '2026-09-22 10:00:00+00' }),
      cargo('c1', '2026-09-21', { created_at: '2026-09-22 09:00:00+00' }),
    ]);
    expect(d).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c1' });
    expect(d.motivo).toContain('cargos idénticos: el más antiguo');
  });

  it('sin pista y fechas DISTINTAS ⇒ AMBIGUO (lo decide el humano)', () => {
    const d = elegirCargoReverso(abono('a', '2026-09-23', 'DEVOLUCION'), [
      cargo('c10', '2026-09-10'),
      cargo('c21', '2026-09-21'),
    ]);
    expect(d.resultado).toBe('AMBIGUO');
    expect(d.cargo_id).toBeNull();
    expect(d.motivo).toBe(
      '2 cargos pendientes por $825.13 en fechas distintas (10-09, 21-09): elige a mano cuál devolvió el banco.',
    );
  });

  it('sin candidatos ⇒ SIN_CANDIDATO con el monto', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'DEVOLUCION', { monto: 1234.5 }),
      [cargo('c', '2026-09-21')],
    );
    expect(d.resultado).toBe('SIN_CANDIDATO');
    expect(d.motivo).toBe(
      'No hay cargos pendientes por $1,234.50 en los 60 días previos a la devolución.',
    );
  });
});

describe('emparejarReversos — CASO REAL 21/23-sep (7 devoluciones, 7 cargos pendientes)', () => {
  it('empareja las 7 con 7 cargos DISTINTOS del 21-sep', () => {
    const d = emparejarReversos(ABONOS_REALES, CARGOS_REALES);
    expect(d).toHaveLength(7);
    expect(d.every((x) => x.resultado === 'EMPAREJADO')).toBe(true);
    const cargos = d.map((x) => x.cargo_id);
    expect(new Set(cargos).size).toBe(7);
    expect([...cargos].sort()).toEqual(CARGOS_REALES.map((c) => c.id).sort());
    expect(d.every((x) => x.pista_fecha === '2026-09-21')).toBe(true);
  });

  it('determinista: el orden de entrada no cambia QUÉ pares salen', () => {
    const a = emparejarReversos(ABONOS_REALES, CARGOS_REALES);
    const b = emparejarReversos(
      [...ABONOS_REALES].reverse(),
      [...CARGOS_REALES].reverse(),
    );
    const clave = (xs: typeof a) =>
      xs.map((x) => `${x.abono_id}>${x.cargo_id}`).sort();
    expect(clave(b)).toEqual(clave(a));
  });

  it('si solo quedan 6 cargos libres, la 7.ª devolución queda SIN_CANDIDATO', () => {
    const d = emparejarReversos(ABONOS_REALES, CARGOS_REALES.slice(0, 6));
    expect(d.filter((x) => x.resultado === 'EMPAREJADO')).toHaveLength(6);
    const sobra = d.filter((x) => x.resultado !== 'EMPAREJADO');
    expect(sobra).toHaveLength(1);
    expect(sobra[0].resultado).toBe('SIN_CANDIDATO');
  });

  it('los abonos que NO son devolución se ignoran', () => {
    const d = emparejarReversos(
      [abono('spei', '2026-09-23', 'SPEI RECIBIDO LETICIA LEON ALVARADO')],
      CARGOS_REALES,
    );
    expect(d).toEqual([]);
  });
});

describe('emparejarReversos — las que traen fecha van primero y se repasan', () => {
  it('la ambigua se resuelve cuando la de la pista se lleva su cargo', () => {
    const d = emparejarReversos(
      [
        abono('sin-pista', '2026-09-23', 'DEVOLUCION', {
          created_at: '2026-09-23 01:00:00+00',
        }),
        abono('con-pista', '2026-09-23', 'CARGO INDEBIDO 21 SEP', {
          created_at: '2026-09-23 02:00:00+00',
        }),
      ],
      [cargo('c10', '2026-09-10'), cargo('c21', '2026-09-21')],
    );
    const por = Object.fromEntries(d.map((x) => [x.abono_id, x]));
    expect(por['con-pista']).toMatchObject({
      resultado: 'EMPAREJADO',
      cargo_id: 'c21',
    });
    expect(por['sin-pista']).toMatchObject({
      resultado: 'EMPAREJADO',
      cargo_id: 'c10',
    });
  });

  it('un cargo nunca se asigna a dos devoluciones', () => {
    const d = emparejarReversos(
      [
        abono('a1', '2026-09-23', 'DEVOLUCION'),
        abono('a2', '2026-09-24', 'DEVOLUCION'),
      ],
      [cargo('unico', '2026-09-21')],
    );
    expect(d.filter((x) => x.resultado === 'EMPAREJADO')).toHaveLength(1);
    expect(d.filter((x) => x.resultado === 'SIN_CANDIDATO')).toHaveLength(1);
  });
});

const fila = (
  extra: Partial<MovimientoParReverso> = {},
): MovimientoParReverso => ({
  id: 'x',
  tipo: 'ABONO',
  cuenta_bancaria_id: CTA,
  monto: 825.13,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  ingreso_id: null,
  clasificacion_id: null,
  reverso_de_id: null,
  ...extra,
});

describe('movimientoLibreParaReverso', () => {
  it('pendiente y sin ligas ⇒ libre', () => {
    expect(movimientoLibreParaReverso(fila())).toBe(true);
  });
  it.each([
    ['conciliado', { conciliado: true }],
    ['gasto', { gasto_id: 'g' }],
    ['cobro', { cobro_id: 'c' }],
    ['sobre', { cobro_grupo_id: 's' }],
    ['ingreso', { ingreso_id: 'i' }],
    ['clasificación', { clasificacion_id: 'k' }],
    ['otra devolución', { reverso_de_id: 'r' }],
  ])('con %s ⇒ NO libre', (_n, extra) => {
    expect(movimientoLibreParaReverso(fila(extra))).toBe(false);
  });
});

describe('motivoParInvalido — espejo del trigger', () => {
  const abonoOk = fila({ id: 'a', tipo: 'ABONO' });
  const cargoOk = fila({ id: 'c', tipo: 'CARGO' });

  it('par válido ⇒ null', () => {
    expect(motivoParInvalido(abonoOk, cargoOk)).toBeNull();
    // El propio abono ya devolviéndolo no es «otro».
    expect(motivoParInvalido(abonoOk, cargoOk, 'a')).toBeNull();
  });

  it('tipos, cuenta y monto', () => {
    expect(motivoParInvalido(cargoOk, abonoOk)).toBe(
      'Se empareja un CARGO con el ABONO que lo devuelve.',
    );
    expect(
      motivoParInvalido(abonoOk, { ...cargoOk, cuenta_bancaria_id: OTRA_CTA }),
    ).toBe('El cargo y su devolución deben ser de la misma cuenta bancaria.');
    expect(motivoParInvalido(abonoOk, { ...cargoOk, monto: 826.13 })).toBe(
      'Los montos no coinciden (cargo $826.13, devolución $825.13).',
    );
    expect(
      motivoParInvalido(abonoOk, { ...cargoOk, monto: '825.134' }),
    ).toBeNull();
  });

  it('ligas: el cargo con gasto JAMÁS', () => {
    expect(motivoParInvalido(abonoOk, { ...cargoOk, gasto_id: 'g' })).toBe(
      'El cargo ya está conciliado con un gasto: quítalo antes.',
    );
    expect(motivoParInvalido({ ...abonoOk, cobro_id: 'c' }, cargoOk)).toBe(
      'El abono ya está conciliado con un cobro de vuelo: quítalo antes.',
    );
    expect(motivoParInvalido({ ...abonoOk, ingreso_id: 'i' }, cargoOk)).toBe(
      'El abono ya está conciliado con un ingreso: quítalo antes.',
    );
    expect(
      motivoParInvalido(abonoOk, { ...cargoOk, clasificacion_id: 'k' }),
    ).toBe('El cargo ya está conciliado con una clasificación: quítalo antes.');
  });

  it('doble devolución', () => {
    expect(
      motivoParInvalido({ ...abonoOk, reverso_de_id: 'otro' }, cargoOk),
    ).toBe('Ese abono ya es la devolución de otro cargo.');
    expect(motivoParInvalido(abonoOk, cargoOk, 'otro-abono')).toBe(
      'Ese cargo ya tiene su devolución emparejada.',
    );
  });
});

describe('motivoTriggerReverso', () => {
  it('23514 del trigger ⇒ el motivo sin prefijo', () => {
    expect(
      motivoTriggerReverso({
        code: '23514',
        message:
          'REVERSO_INVALIDO: el cargo ya está conciliado con un gasto, cobro o ingreso',
      }),
    ).toBe('el cargo ya está conciliado con un gasto, cobro o ingreso');
  });
  it('23505 del índice único ⇒ ya tiene su devolución', () => {
    expect(
      motivoTriggerReverso({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_mov_bancario_reverso_de"',
      }),
    ).toBe('Ese cargo ya tiene su devolución emparejada.');
  });
  it('cualquier otro error ⇒ null', () => {
    expect(
      motivoTriggerReverso({ code: '23514', message: 'GASTO_YA_CUBIERTO: …' }),
    ).toBeNull();
    expect(motivoTriggerReverso(null)).toBeNull();
  });
});

describe('notas y etiquetas', () => {
  const c = { fecha: '2026-09-21', descripcion: 'ASUR CANCUN' };
  const a = { fecha: '2026-09-23', descripcion: 'CARGO INDEBIDO 21 SEP 35552' };

  it('textos exactos del contrato', () => {
    expect(fechaCortaReverso('2026-09-21')).toBe('21-09');
    expect(notaAbonoReverso(c)).toBe(
      'Devuelve el cargo del 21-09 · ASUR CANCUN',
    );
    expect(notaCargoReverso(a)).toBe(
      'Devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    );
    expect(notaAbonoReverso({ fecha: '2026-09-21', descripcion: null })).toBe(
      'Devuelve el cargo del 21-09',
    );
    expect(
      notaCargoReverso({
        fecha: '2026-09-23',
        descripcion: 'ASA CANCUN\nCARR',
      }),
    ).toBe('Devuelto el 23-09 · ASA CANCUN CARR');
  });

  it('se ANTEPONE sin pisar lo de la oficina, y no se duplica al re-emparejar', () => {
    const conOficina = anteponerNotaReverso(
      'Revisado con el banco (folio 88)',
      notaAbonoReverso(c),
    );
    expect(conOficina).toBe(
      'Devuelve el cargo del 21-09 · ASUR CANCUN\nRevisado con el banco (folio 88)',
    );
    expect(anteponerNotaReverso(conOficina, notaAbonoReverso(c))).toBe(
      conOficina,
    );
    expect(anteponerNotaReverso(null, notaCargoReverso(a))).toBe(
      'Devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    );
  });

  it('al desemparejar se quita SOLO lo del emparejado', () => {
    expect(
      quitarNotaReverso(
        'Devuelve el cargo del 21-09 · ASUR CANCUN\nRevisado con el banco (folio 88)',
      ),
    ).toBe('Revisado con el banco (folio 88)');
    expect(quitarNotaReverso('Devuelto el 23-09 · CARGO INDEBIDO')).toBeNull();
    expect(quitarNotaReverso('Regla: SEL TRASPASO')).toBe(
      'Regla: SEL TRASPASO',
    );
    expect(quitarNotaReverso(null)).toBeNull();
  });

  it('«Conciliado con» del reporte', () => {
    expect(etiquetaConciliadoReverso('ABONO', c)).toBe(
      'Reverso de un cargo · devuelve el cargo del 21-09 · ASUR CANCUN',
    );
    expect(etiquetaConciliadoReverso('CARGO', a)).toBe(
      'Reverso de un cargo · devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552',
    );
    expect(
      etiquetaConciliadoReverso('CARGO', { fecha: '2026-09-23' }, 'Reverso'),
    ).toBe('Reverso · devuelto el 23-09');
  });
});

// =====================================================================
// Revisión adversaria (30-sep-2026): un cargo YA explicado con dinero
// (gasto/cobro/sobre/ingreso) nunca se empareja, pero FRENA al automático
// cuando es el que más probablemente devolvió el banco.
describe('elegirCargoReverso — freno de los cargos ya ligados a un gasto', () => {
  const merida = (
    id: string,
    fecha: string,
    extra: Partial<MovimientoReverso> = {},
  ): MovimientoReverso =>
    cargo(id, fecha, { monto: 110.82, descripcion: 'ASUR Merida', ...extra });

  it('CASO REAL «REV.ASUR MERIDA» 07-08: su cargo del 07-08 tiene gasto ⇒ AMBIGUO, NO se toma uno del 06-07', () => {
    const d = elegirCargoReverso(
      abono('rev', '2026-08-07', 'REV.ASUR MERIDA', { monto: 110.82 }),
      [merida('m1', '2026-07-06'), merida('m2', '2026-07-06')],
      [merida('m-gasto', '2026-08-07')],
    );
    expect(d.resultado).toBe('AMBIGUO');
    expect(d.cargo_id).toBeNull();
    expect(d.motivo).toBe(
      'El cargo por $110.82 más reciente (07-08) ya está conciliado con un gasto o cobro y los pendientes son de otra fecha (06-07): elige a mano cuál devolvió el banco.',
    );
    // Sin el freno (lo de antes) se habría emparejado con m1, un mes antes.
    expect(
      elegirCargoReverso(
        abono('rev', '2026-08-07', 'REV.ASUR MERIDA', { monto: 110.82 }),
        [merida('m1', '2026-07-06'), merida('m2', '2026-07-06')],
      ).cargo_id,
    ).toBe('m1');
  });

  it('un ligado del MISMO día que los libres no frena (el caso real del 21-sep)', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'CARGO INDEBIDO 21 SEP 35552'),
      CARGOS_REALES,
      [cargo('1263ca78', '2026-09-21')],
    );
    expect(d.resultado).toBe('EMPAREJADO');
    const sinPista = elegirCargoReverso(
      abono('b', '2026-09-23', 'DEVOLUCION'),
      [cargo('c1', '2026-09-21')],
      [cargo('g1', '2026-09-21')],
    );
    expect(sinPista).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c1' });
  });

  it('un ligado MÁS VIEJO que el libre no frena', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'DEVOLUCION'),
      [cargo('c20', '2026-09-20')],
      [cargo('g01', '2026-09-01')],
    );
    expect(d).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c20' });
  });

  it('con pista: el cargo de ESA fecha está ligado ⇒ SIN_CANDIDATO (no se brinca a ±3 días)', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-25', 'CARGO INDEBIDO 21 SEP'),
      [cargo('c22', '2026-09-22')],
      [cargo('g21', '2026-09-21')],
    );
    expect(d.resultado).toBe('SIN_CANDIDATO');
    expect(d.motivo).toBe(
      'El banco indica un cargo del 21-09 por $825.13 y ese cargo ya está conciliado con un gasto o cobro: revísalo a mano.',
    );
  });

  it('con pista y ±3 días: un ligado MÁS CERCA de la fecha que el libre ⇒ AMBIGUO', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-25', 'CARGO INDEBIDO 21 SEP'),
      [cargo('c24', '2026-09-24')],
      [cargo('g22', '2026-09-22')],
    );
    expect(d.resultado).toBe('AMBIGUO');
    expect(d.motivo).toContain('(el del 22-09) ya está conciliado');
    // Ligado más lejos que el libre: sí se empareja.
    expect(
      elegirCargoReverso(
        abono('a', '2026-09-25', 'CARGO INDEBIDO 21 SEP'),
        [cargo('c22', '2026-09-22')],
        [cargo('g24', '2026-09-24')],
      ),
    ).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c22' });
  });

  it('los ligados de OTRA cuenta, otro monto o fuera de la ventana no cuentan', () => {
    const d = elegirCargoReverso(
      abono('a', '2026-09-23', 'DEVOLUCION'),
      [cargo('c01', '2026-09-01')],
      [
        cargo('g-otra', '2026-09-22', { cuenta_bancaria_id: 'otra' }),
        cargo('g-monto', '2026-09-22', { monto: 825.2 }),
        cargo('g-despues', '2026-09-24'),
      ],
    );
    expect(d).toMatchObject({ resultado: 'EMPAREJADO', cargo_id: 'c01' });
  });

  it('LOTE REAL de los «REV» de jul/ago: los dos del 06-07 se emparejan; el del 07-08 queda para el humano', () => {
    const libres = [1, 2, 3, 4].map((n) =>
      merida(`m${n}`, '2026-07-06', {
        created_at: `2026-07-07 10:00:0${n}+00`,
      }),
    );
    const d = emparejarReversos(
      [
        abono('r1', '2026-07-06', 'Rev ASUR Merida', { monto: 110.82 }),
        abono('r2', '2026-07-06', 'Rev ASUR Merida', { monto: 110.82 }),
        abono('r3', '2026-08-07', 'REV.ASUR MERIDA', { monto: 110.82 }),
      ],
      libres,
      [merida('m-gasto', '2026-08-07')],
    );
    const por = new Map(d.map((x) => [x.abono_id, x]));
    expect(por.get('r1')).toMatchObject({ resultado: 'EMPAREJADO' });
    expect(por.get('r2')).toMatchObject({ resultado: 'EMPAREJADO' });
    expect(por.get('r1')!.cargo_id).not.toBe(por.get('r2')!.cargo_id);
    expect(por.get('r3')).toMatchObject({
      resultado: 'AMBIGUO',
      cargo_id: null,
    });
  });
});

describe('cargoLigadoConDinero', () => {
  const base: MovimientoParReverso = {
    id: 'c',
    tipo: 'CARGO',
    cuenta_bancaria_id: CTA,
    monto: 1,
  };
  it('gasto, cobro, sobre o ingreso ⇒ sí; clasificación, abono o nada ⇒ no', () => {
    expect(cargoLigadoConDinero({ ...base, gasto_id: 'g' })).toBe(true);
    expect(cargoLigadoConDinero({ ...base, cobro_id: 'x' })).toBe(true);
    expect(cargoLigadoConDinero({ ...base, cobro_grupo_id: 'x' })).toBe(true);
    expect(cargoLigadoConDinero({ ...base, ingreso_id: 'x' })).toBe(true);
    expect(
      cargoLigadoConDinero({
        ...base,
        clasificacion_id: 'x',
        conciliado: true,
      }),
    ).toBe(false);
    expect(
      cargoLigadoConDinero({ ...base, tipo: 'ABONO', gasto_id: 'g' }),
    ).toBe(false);
    expect(cargoLigadoConDinero(base)).toBe(false);
  });
});
