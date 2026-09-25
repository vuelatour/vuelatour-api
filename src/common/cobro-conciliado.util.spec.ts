import {
  anticipoDeCobro,
  cobroEstaConciliado,
  conciliacionDeCobro,
  filtroLigaCobrosConAnticipos,
  MOV_LIGA_COLS_CON_INGRESO,
  esParteDeSobre,
  filtroLigaCobros,
  movimientoDeCobro,
  movimientoDeSobre,
  sobreDeCobro,
  sobreEstaConciliado,
} from './cobro-conciliado.util';

const MOVS = [
  { id: 'm1', cobro_id: 'c1', cobro_grupo_id: null },
  { id: 'm2', cobro_id: null, cobro_grupo_id: 's1' },
  { id: 'm3', cobro_id: null, cobro_grupo_id: null },
];

describe('cobro-conciliado.util (fuente única de "conciliado")', () => {
  it('cobro normal: conciliado solo si un movimiento tiene su cobro_id', () => {
    expect(cobroEstaConciliado({ id: 'c1' }, MOVS)).toBe(true);
    expect(movimientoDeCobro({ id: 'c1' }, MOVS)?.id).toBe('m1');
    expect(cobroEstaConciliado({ id: 'c9' }, MOVS)).toBe(false);
    expect(movimientoDeCobro({ id: 'c9' }, MOVS)).toBeNull();
  });

  it('parte de un sobre: hereda la conciliación del sobre (cobro_grupo_id)', () => {
    const parte = { id: 'c7', cobro_grupo_id: 's1' };
    expect(esParteDeSobre(parte)).toBe(true);
    expect(sobreDeCobro(parte)).toBe('s1');
    expect(cobroEstaConciliado(parte, MOVS)).toBe(true);
    expect(movimientoDeCobro(parte, MOVS)?.id).toBe('m2');
  });

  it('parte de un sobre SIN movimiento: no conciliada', () => {
    const parte = { id: 'c8', cobro_grupo_id: 's2' };
    expect(cobroEstaConciliado(parte, MOVS)).toBe(false);
    expect(movimientoDeCobro(parte, MOVS)).toBeNull();
  });

  it('la liga directa gana sobre la del sobre (defensivo: nunca deberían coexistir)', () => {
    const movs = [
      { id: 'mA', cobro_id: 'c5', cobro_grupo_id: null },
      { id: 'mB', cobro_id: null, cobro_grupo_id: 's5' },
    ];
    expect(
      movimientoDeCobro({ id: 'c5', cobro_grupo_id: 's5' }, movs)?.id,
    ).toBe('mA');
  });

  it('sobre: conciliado si un movimiento tiene su cobro_grupo_id', () => {
    expect(sobreEstaConciliado('s1', MOVS)).toBe(true);
    expect(movimientoDeSobre('s1', MOVS)?.id).toBe('m2');
    expect(sobreEstaConciliado('s2', MOVS)).toBe(false);
    expect(sobreEstaConciliado('', MOVS)).toBe(false);
  });

  it('cobro_grupo_id no-string (null, undefined, vacío) = cobro normal', () => {
    expect(esParteDeSobre({ id: 'x', cobro_grupo_id: null })).toBe(false);
    expect(esParteDeSobre({ id: 'x', cobro_grupo_id: undefined })).toBe(false);
    expect(esParteDeSobre({ id: 'x', cobro_grupo_id: '' })).toBe(false);
    expect(esParteDeSobre({ id: 'x' })).toBe(false);
  });

  it('sin movimientos: nada está conciliado', () => {
    expect(cobroEstaConciliado({ id: 'c1' }, [])).toBe(false);
    expect(cobroEstaConciliado({ id: 'c1', cobro_grupo_id: 's1' }, [])).toBe(
      false,
    );
    expect(sobreEstaConciliado('s1', [])).toBe(false);
  });

  describe('filtroLigaCobros (cláusula .or() de PostgREST)', () => {
    it('solo cobros', () => {
      expect(filtroLigaCobros(['a', 'b'], [])).toBe('cobro_id.in.(a,b)');
    });
    it('solo sobres', () => {
      expect(filtroLigaCobros([], ['s'])).toBe('cobro_grupo_id.in.(s)');
    });
    it('ambos, sin repetidos ni vacíos', () => {
      expect(filtroLigaCobros(['a', 'a', ''], ['s', 's'])).toBe(
        'cobro_id.in.(a),cobro_grupo_id.in.(s)',
      );
    });
    it('nada que buscar → null (el caller se salta la consulta)', () => {
      expect(filtroLigaCobros([], [])).toBeNull();
      expect(filtroLigaCobros([''], [])).toBeNull();
    });
  });
});

// ===== ANTICIPOS (24-sep-2026, §7.4-bis): SOLO aditivo =====

describe('cobro-conciliado.util — cobros de ANTICIPO', () => {
  const MOVS_ING = [
    { id: 'm1', cobro_id: 'c1', cobro_grupo_id: null, ingreso_id: null },
    { id: 'm2', cobro_id: null, cobro_grupo_id: 's1', ingreso_id: null },
    { id: 'm4', cobro_id: null, cobro_grupo_id: null, ingreso_id: 'ing-1' },
  ];

  it('columnas con ingreso_id (solo con la sonda)', () => {
    expect(MOV_LIGA_COLS_CON_INGRESO).toBe(
      'id, cobro_id, cobro_grupo_id, ingreso_id',
    );
  });

  it('conciliacionDeCobro: DIRECTO, SOBRE y ANTICIPO', () => {
    expect(conciliacionDeCobro({ id: 'c1' }, MOVS_ING)).toEqual({
      mov: MOVS_ING[0],
      via: 'DIRECTO',
    });
    expect(
      conciliacionDeCobro({ id: 'c7', cobro_grupo_id: 's1' }, MOVS_ING),
    ).toEqual({ mov: MOVS_ING[1], via: 'SOBRE' });
    expect(
      conciliacionDeCobro({ id: 'c9', ingreso_anticipo_id: 'ing-1' }, MOVS_ING),
    ).toEqual({ mov: MOVS_ING[2], via: 'ANTICIPO' });
  });

  it('cobro de un anticipo SIN conciliar ⇒ null; cobro normal sin liga ⇒ null', () => {
    expect(
      conciliacionDeCobro({ id: 'c9', ingreso_anticipo_id: 'ing-2' }, MOVS_ING),
    ).toBeNull();
    expect(conciliacionDeCobro({ id: 'c9' }, MOVS_ING)).toBeNull();
    expect(anticipoDeCobro({ id: 'x', ingreso_anticipo_id: '' })).toBeNull();
    expect(anticipoDeCobro({ id: 'x', ingreso_anticipo_id: 'ing-1' })).toBe(
      'ing-1',
    );
  });

  it('un cobro de anticipo NO es «conciliado» para movimientoDeCobro (el candado de desaplicar no se dispara)', () => {
    const cobro = { id: 'c9', ingreso_anticipo_id: 'ing-1' };
    expect(movimientoDeCobro(cobro, MOVS_ING)).toBeNull();
    expect(cobroEstaConciliado(cobro, MOVS_ING)).toBe(false);
  });

  it('filtroLigaCobrosConAnticipos agrega ingreso_id.in.(…) sin tocar lo de siempre', () => {
    expect(filtroLigaCobrosConAnticipos(['a'], ['s'], [])).toBe(
      filtroLigaCobros(['a'], ['s']),
    );
    expect(filtroLigaCobrosConAnticipos(['a'], [], ['i1', 'i1', ''])).toBe(
      'cobro_id.in.(a),ingreso_id.in.(i1)',
    );
    expect(filtroLigaCobrosConAnticipos([], [], ['i1'])).toBe(
      'ingreso_id.in.(i1)',
    );
    expect(filtroLigaCobrosConAnticipos([], [], [])).toBeNull();
  });
});
