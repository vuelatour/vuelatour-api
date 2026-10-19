import {
  CODIGO_PROPIETARIO,
  MENSAJE_SUSTITUYE_INVALIDO,
  diaAnterior,
  diaDeDate,
  diaMas,
  errorVigencia,
  esDia,
  excesoPorcentaje,
  fmtDiaMx,
  fmtPct,
  mensajeHastaAntesDelInicio,
  mensajeSumaExcede,
  mensajeSustituyeAntesDelInicio,
  planSustitucion,
} from './propietarios.util';

const AVION = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTRO_AVION = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('propietarios.util — fechas de pared', () => {
  it('esDia acepta solo días reales AAAA-MM-DD', () => {
    expect(esDia('2026-10-19')).toBe(true);
    expect(esDia('2024-02-29')).toBe(true);
    expect(esDia('2026-02-30')).toBe(false);
    expect(esDia('2026-10-19T00:00:00Z')).toBe(false);
    expect(esDia('19/10/2026')).toBe(false);
    expect(esDia('')).toBe(false);
    expect(esDia(undefined)).toBe(false);
  });

  it('diaMas / diaAnterior cruzan mes, año y bisiesto sin zona horaria', () => {
    expect(diaMas('2026-10-19', 1)).toBe('2026-10-20');
    expect(diaAnterior('2026-08-18')).toBe('2026-08-17');
    expect(diaAnterior('2026-01-01')).toBe('2025-12-31');
    expect(diaAnterior('2024-03-01')).toBe('2024-02-29');
    expect(diaMas('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('diaDeDate: el Date que arma class-transformer desde «2026-08-18»', () => {
    expect(diaDeDate(new Date('2026-08-18'))).toBe('2026-08-18');
  });

  it('fmtDiaMx', () => {
    expect(fmtDiaMx('2026-08-17')).toBe('17/08/2026');
  });
});

describe('propietarios.util — vigencia y textos', () => {
  it('errorVigencia: abierta o hasta ≥ desde ⇒ null; hasta < desde ⇒ el texto', () => {
    expect(errorVigencia('Hernan Garza', '2020-01-01', null)).toBeNull();
    expect(
      errorVigencia('Hernan Garza', '2020-01-01', '2020-01-01'),
    ).toBeNull();
    expect(
      errorVigencia('Hernan Garza', '2020-01-01', '2026-08-17'),
    ).toBeNull();
    expect(errorVigencia('Alejandro Canales', '2026-08-18', '2026-08-17')).toBe(
      'Alejandro Canales empezó el 18/08/2026: no puede terminar el 17/08/2026. Si se agregó por error, bórralo del historial.',
    );
  });

  it('textos exactos', () => {
    expect(
      mensajeHastaAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-17',
      ),
    ).toBe(
      'Alejandro Canales empezó el 18/08/2026: no puede terminar el 17/08/2026. Si se agregó por error, bórralo del historial.',
    );
    expect(
      mensajeSustituyeAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-18',
      ),
    ).toBe(
      'Alejandro Canales empezó el 18/08/2026: no puede terminar el 17/08/2026 (el día anterior al nuevo régimen). Si se agregó por error, bórralo del historial; si no, pon una fecha de inicio posterior.',
    );
  });
});

describe('planSustitucion — el caso XA-VGV', () => {
  const hernan = {
    id: 'h',
    aeronave_id: AVION,
    vigente_desde: '2020-01-01',
    vigente_hasta: null,
    nombre: 'Hernan Garza',
  };

  it('Alejandro entra el 18-ago sustituyendo a Hernan ⇒ Hernan termina el 17-ago', () => {
    expect(planSustitucion(AVION, '2026-08-18', ['h'], [hernan])).toEqual({
      ok: true,
      cerrar: [{ id: 'h', hasta: '2026-08-17' }],
    });
  });

  it('ids repetidos se cierran una vez; sin sustituidos, nada que cerrar', () => {
    expect(planSustitucion(AVION, '2026-08-18', ['h', 'h'], [hernan])).toEqual({
      ok: true,
      cerrar: [{ id: 'h', hasta: '2026-08-17' }],
    });
    expect(planSustitucion(AVION, '2026-08-18', [], [])).toEqual({
      ok: true,
      cerrar: [],
    });
  });

  it('un sustituido que YA termina ese día o antes no se toca', () => {
    const cerrado = { ...hernan, vigente_hasta: '2026-06-07' };
    expect(planSustitucion(AVION, '2026-08-18', ['h'], [cerrado])).toEqual({
      ok: true,
      cerrar: [],
    });
    const justo = { ...hernan, vigente_hasta: '2026-08-17' };
    expect(planSustitucion(AVION, '2026-08-18', ['h'], [justo])).toEqual({
      ok: true,
      cerrar: [],
    });
    // Termina DESPUÉS del último día: sí se recorta.
    const largo = { ...hernan, vigente_hasta: '2026-12-31' };
    expect(planSustitucion(AVION, '2026-08-18', ['h'], [largo])).toEqual({
      ok: true,
      cerrar: [{ id: 'h', hasta: '2026-08-17' }],
    });
  });

  it('un id que no existe o es de otro avión ⇒ SUSTITUYE_INVALIDO', () => {
    expect(planSustitucion(AVION, '2026-08-18', ['x'], [hernan])).toEqual({
      ok: false,
      code: CODIGO_PROPIETARIO.SUSTITUYE_INVALIDO,
      message: MENSAJE_SUSTITUYE_INVALIDO,
    });
    const ajeno = { ...hernan, aeronave_id: OTRO_AVION };
    expect(planSustitucion(AVION, '2026-08-18', ['h'], [ajeno]).ok).toBe(false);
  });

  it('un sustituido que empezó después del último día ⇒ VIGENCIA_INVALIDA (bórralo si fue error)', () => {
    const reciente = {
      ...hernan,
      id: 'r',
      vigente_desde: '2026-08-18',
      nombre: 'Alejandro Canales',
    };
    expect(planSustitucion(AVION, '2026-08-18', ['r'], [reciente])).toEqual({
      ok: false,
      code: CODIGO_PROPIETARIO.VIGENCIA_INVALIDA,
      message: mensajeSustituyeAntesDelInicio(
        'Alejandro Canales',
        '2026-08-18',
        '2026-08-18',
      ),
    });
    // Empezó justo el último día: sí puede terminar ese día.
    const mismoDia = { ...reciente, vigente_desde: '2026-08-17' };
    expect(planSustitucion(AVION, '2026-08-18', ['r'], [mismoDia])).toEqual({
      ok: true,
      cerrar: [{ id: 'r', hasta: '2026-08-17' }],
    });
  });

  it('con un rechazo no devuelve nada que cerrar (todo o nada)', () => {
    const r = planSustitucion(AVION, '2026-08-18', ['h', 'x'], [hernan]);
    expect(r.ok).toBe(false);
    expect('cerrar' in r).toBe(false);
  });
});

describe('excesoPorcentaje — nunca más del 100 % en un mismo día', () => {
  const hernan = {
    id: 'h',
    nombre: 'Hernan Garza',
    porcentaje: '100.000',
    vigente_desde: '2020-01-01',
    vigente_hasta: null,
  };
  const alejandro = {
    id: 'a',
    nombre: 'Alejandro Canales',
    porcentaje: 100,
    vigente_desde: '2026-08-18',
    vigente_hasta: null,
  };

  it('el caso XA-VGV (100 + 100 encimados desde el 18-ago) ⇒ exceso ese día', () => {
    const e = excesoPorcentaje([hernan, alejandro]);
    expect(e).toEqual({
      dia: '2026-08-18',
      suma: 200,
      propietarios: [
        { id: 'h', nombre: 'Hernan Garza', porcentaje: 100 },
        { id: 'a', nombre: 'Alejandro Canales', porcentaje: 100 },
      ],
    });
    expect(mensajeSumaExcede(e!)).toBe(
      'Los propietarios sumarían 200 % el 18/08/2026 (Hernan Garza 100 % + Alejandro Canales 100 %): no pueden pasar de 100 %. Pon el último día del que sale o baja los porcentajes.',
    );
  });

  it('con Hernan terminando el 17-ago ya no se enciman ⇒ null', () => {
    expect(
      excesoPorcentaje([{ ...hernan, vigente_hasta: '2026-08-17' }, alejandro]),
    ).toBeNull();
    // Terminando el MISMO 18-ago sí se enciman un día.
    expect(
      excesoPorcentaje([{ ...hernan, vigente_hasta: '2026-08-18' }, alejandro])
        ?.dia,
    ).toBe('2026-08-18');
  });

  it('menos de 100 se permite; 100 exacto con 3 decimales también; 100.001 no', () => {
    const n621 = [
      {
        id: '1',
        nombre: 'Aero Charter',
        porcentaje: '20.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        id: '2',
        nombre: 'Moreno',
        porcentaje: '12.432',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        id: '3',
        nombre: 'Macedo',
        porcentaje: '26.648',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ];
    expect(excesoPorcentaje(n621)).toBeNull();
    const completo = [
      ...n621,
      {
        id: '4',
        nombre: 'Hernan Garza',
        porcentaje: '40.920',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ];
    expect(excesoPorcentaje(completo)).toBeNull();
    expect(
      excesoPorcentaje([
        ...n621,
        {
          id: '4',
          nombre: 'Hernan Garza',
          porcentaje: '40.921',
          vigente_desde: '2020-01-01',
          vigente_hasta: null,
        },
      ])?.suma,
    ).toBe(100.001);
    // 0.1 + 0.2 no acumula basura binaria.
    expect(
      excesoPorcentaje([
        {
          id: 'x',
          nombre: 'X',
          porcentaje: 99.9,
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          id: 'y',
          nombre: 'Y',
          porcentaje: 0.1,
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
      ]),
    ).toBeNull();
  });

  it('un régimen cerrado antes no cuenta; uno que empieza después tampoco hasta su día', () => {
    expect(
      excesoPorcentaje([
        { ...hernan, vigente_hasta: '2026-06-07' },
        { ...alejandro, vigente_desde: '2026-06-08' },
      ]),
    ).toBeNull();
    const e = excesoPorcentaje([
      hernan,
      { ...alejandro, vigente_desde: '2027-01-01', porcentaje: 30 },
    ]);
    expect(e?.dia).toBe('2027-01-01');
    expect(e?.suma).toBe(130);
  });

  it('fmtPct sin ceros de cola', () => {
    expect(fmtPct(100)).toBe('100 %');
    expect(fmtPct(40.92)).toBe('40.92 %');
    expect(fmtPct(12.432)).toBe('12.432 %');
  });
});
