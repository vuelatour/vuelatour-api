import {
  anclarTramoAlCotizado,
  avisoAnclaDeTramos,
  avisoTramoCancelado,
  avisoTramoConTacoConservado,
  columnasQueConservaLaOperacion,
  mismaRuta,
  normalizarTramosBase,
  rutaTxt,
  tramosCotizados,
  tramosCotizadosPorOrden,
  type TramoCotizado,
} from './tramos-cotizados.util';

/**
 * LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN — TRAMOS (22-sep-2026).
 *
 * Fixture REAL de la cotización #326 (N621TX, CUN-PTU-CUN, 19-sep-2026):
 * se cotizó `T1 CUN→PTU FERRY` + `T2 PTU→CUN 2 pax` (TUAS $0 porque el T1
 * sale de CUN sin pasajeros y en PTU la matrícula N está exenta) ⇒
 * $3,596.00. Al día siguiente el PILOTO editó los DOS tramos desde la app:
 * 4 pax y sin ferry. Reabrir el cotizador y teclear el T.C. repreciaba con
 * la OPERACIÓN (TUA CUN $25 × 4 + IVA) ⇒ $3,712.00.
 */

const COTIZADO_326: TramoCotizado[] = [
  {
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'PTU',
    millas_nauticas: 127.5,
    pasajeros: 0,
    pasajeros_nombres: [],
    es_ferry: true,
    requiere_pernocta: false,
    pernocta_costo_usd: 0,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    notas: null,
  },
  {
    orden: 2,
    origen_iata: 'PTU',
    destino_iata: 'CUN',
    millas_nauticas: 127.5,
    pasajeros: 2,
    pasajeros_nombres: [],
    es_ferry: false,
    requiere_pernocta: false,
    pernocta_costo_usd: 0,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    notas: null,
  },
];

/** `calculo_snapshot` de la #326 tal como lo deja el motor. */
const snapshot326 = {
  ruta: {
    escalas: COTIZADO_326.map((t) => ({
      origen_iata: t.origen_iata,
      destino_iata: t.destino_iata,
      millas_nauticas: t.millas_nauticas,
      pasajeros: t.pasajeros,
      pasajeros_nombres: t.pasajeros_nombres,
      es_ferry: t.es_ferry,
      requiere_pernocta: false,
      pernocta_costo_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
      notas: null,
      fecha_salida_plan: '2026-09-20T14:00:00.000Z',
      pdf_oculto: null,
    })),
  },
  tramos: [
    {
      orden: 1,
      origen: 'CUN',
      destino: 'PTU',
      millas: 127.5,
      pasajeros: 0,
      es_ferry: true,
      requiere_pernocta: false,
      pernocta_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
    },
    {
      orden: 2,
      origen: 'PTU',
      destino: 'CUN',
      millas: 127.5,
      pasajeros: 2,
      es_ferry: false,
      requiere_pernocta: false,
      pernocta_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
    },
  ],
};

/** Escalas VIVAS de la #326 tras la edición del PILOTO (20-sep-2026). */
const VIVA_1 = {
  orden: 1,
  origen_iata: 'CUN',
  destino_iata: 'PTU',
  pasajeros: 4,
  es_ferry: false,
  requiere_pernocta: false,
  solo_operativa: false,
  cancelada_at: null,
};
const VIVA_2 = {
  orden: 2,
  origen_iata: 'PTU',
  destino_iata: 'CUN',
  pasajeros: 4,
  es_ferry: false,
  requiere_pernocta: false,
  solo_operativa: false,
  cancelada_at: null,
};

describe('tramosCotizados — cascada del snapshot', () => {
  it('lee ruta.escalas (camino normal) con TODO el detalle', () => {
    const t = tramosCotizados(snapshot326)!;
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'PTU',
      es_ferry: true,
      pasajeros: 0,
    });
    expect(t[1]).toMatchObject({ orden: 2, pasajeros: 2, es_ferry: false });
  });

  it('RESPALDO: sin ruta.escalas lee snapshot.tramos (otros nombres de campo)', () => {
    const t = tramosCotizados({ tramos: snapshot326.tramos })!;
    expect(t.map((x) => [x.origen_iata, x.destino_iata, x.pasajeros])).toEqual([
      ['CUN', 'PTU', 0],
      ['PTU', 'CUN', 2],
    ]);
    // El desglose por tramo nunca guardó manifiesto ni notas.
    expect(t[0].pasajeros_nombres).toEqual([]);
    expect(t[1].notas).toBeNull();
  });

  it('ferry ⇒ 0 pax y sin manifiesto, aunque el snapshot traiga otra cosa', () => {
    const t = tramosCotizados({
      ruta: {
        escalas: [
          {
            origen_iata: 'cun',
            destino_iata: 'ptu',
            millas_nauticas: '127.5',
            pasajeros: 4,
            pasajeros_nombres: ['Ana'],
            es_ferry: true,
          },
        ],
      },
    })!;
    expect(t[0]).toMatchObject({
      origen_iata: 'CUN',
      destino_iata: 'PTU',
      millas_nauticas: 127.5,
      pasajeros: 0,
      es_ferry: true,
    });
    expect(t[0].pasajeros_nombres).toEqual([]);
  });

  it('sin snapshot / snapshot corrupto ⇒ null (manda la operación, como antes)', () => {
    expect(tramosCotizados(null)).toBeNull();
    expect(tramosCotizados({})).toBeNull();
    expect(tramosCotizados({ ruta: { escalas: [] }, tramos: [] })).toBeNull();
    // Fila sin IATAs: la cascada NO se queda a medias.
    expect(
      tramosCotizados({ ruta: { escalas: [{ millas_nauticas: 100 }] } }),
    ).toBeNull();
  });

  it('cae al respaldo cuando ruta.escalas viene corrupta pero tramos no', () => {
    const t = tramosCotizados({
      ruta: { escalas: [{ millas_nauticas: 100 }] },
      tramos: snapshot326.tramos,
    })!;
    expect(t).toHaveLength(2);
    expect(t[1].pasajeros).toBe(2);
  });

  it('tramosCotizadosPorOrden indexa por orden (eje del UPSERT)', () => {
    const m = tramosCotizadosPorOrden(snapshot326);
    expect(m.get(1)!.es_ferry).toBe(true);
    expect(m.get(2)!.pasajeros).toBe(2);
    expect(m.get(3)).toBeUndefined();
    expect(tramosCotizadosPorOrden(null).size).toBe(0);
  });
});

describe('mismaRuta / normalizarTramosBase', () => {
  it('compara IATAs en mayúsculas y sin espacios', () => {
    expect(
      mismaRuta({ origen_iata: ' cun ', destino_iata: 'ptu' }, COTIZADO_326[0]),
    ).toBe(true);
    expect(
      mismaRuta({ origen_iata: 'CUN', destino_iata: 'CZM' }, COTIZADO_326[0]),
    ).toBe(false);
    expect(mismaRuta(null, COTIZADO_326[0])).toBe(false);
    expect(mismaRuta({ origen_iata: 'CUN' }, COTIZADO_326[0])).toBe(false);
  });

  it('EDITADO es alias de COTIZADO; lo desconocido no viaja', () => {
    expect(normalizarTramosBase('COTIZADO')).toBe('COTIZADO');
    expect(normalizarTramosBase('EDITADO')).toBe('COTIZADO');
    expect(normalizarTramosBase('OPERACION')).toBe('OPERACION');
    expect(normalizarTramosBase(undefined)).toBeUndefined();
    expect(normalizarTramosBase('cotizado')).toBeUndefined();
  });
});

describe('anclarTramoAlCotizado — defensa contra un panel VIEJO', () => {
  it('#326: lo entrante es un ECO de la escala viva ⇒ se ancla a lo COTIZADO', () => {
    // Panel viejo: rehidrató los tramos de la operación (4 pax, sin ferry).
    const t1 = anclarTramoAlCotizado(
      {
        origen_iata: 'CUN',
        destino_iata: 'PTU',
        millas_nauticas: 127.5,
        pasajeros: 4,
        pasajeros_nombres: [],
        es_ferry: false,
      },
      COTIZADO_326[0],
      VIVA_1,
      { paxGlobal: 4 },
    );
    expect(t1.anclado.sort()).toEqual(['es_ferry', 'pasajeros']);
    expect(t1.leg.es_ferry).toBe(true);
    expect(t1.leg.pasajeros).toBe(0);
    const t2 = anclarTramoAlCotizado(
      {
        origen_iata: 'PTU',
        destino_iata: 'CUN',
        millas_nauticas: 127.5,
        pasajeros: 4,
        es_ferry: false,
      },
      COTIZADO_326[1],
      VIVA_2,
      { paxGlobal: 4 },
    );
    expect(t2.anclado).toEqual(['pasajeros']);
    expect(t2.leg.pasajeros).toBe(2);
  });

  it('EDICIÓN REAL de la oficina (6 pax ≠ los 4 de la operación) ⇒ NO se ancla', () => {
    const r = anclarTramoAlCotizado(
      {
        origen_iata: 'PTU',
        destino_iata: 'CUN',
        millas_nauticas: 127.5,
        pasajeros: 6,
        es_ferry: false,
      },
      COTIZADO_326[1],
      VIVA_2,
      { paxGlobal: 6 },
    );
    expect(r.anclado).toEqual([]);
    expect(r.leg.pasajeros).toBe(6);
  });

  it('pax heredado del global: el eco se detecta igual (el DTO puede omitirlo)', () => {
    const sinPax: {
      origen_iata: string;
      destino_iata: string;
      millas_nauticas: number;
      pasajeros?: number | null;
    } = { origen_iata: 'PTU', destino_iata: 'CUN', millas_nauticas: 127.5 };
    const r = anclarTramoAlCotizado(sinPax, COTIZADO_326[1], VIVA_2, {
      paxGlobal: 4,
    });
    expect(r.anclado).toEqual(['pasajeros']);
    expect(r.leg.pasajeros).toBe(2);
  });

  it('la operación coincide con lo cotizado ⇒ no hay nada que anclar', () => {
    const r = anclarTramoAlCotizado(
      {
        origen_iata: 'PTU',
        destino_iata: 'CUN',
        millas_nauticas: 127.5,
        pasajeros: 2,
        es_ferry: false,
      },
      COTIZADO_326[1],
      { ...VIVA_2, pasajeros: 2 },
      { paxGlobal: 2 },
    );
    expect(r.anclado).toEqual([]);
    expect(r.leg.pasajeros).toBe(2);
  });

  it('ruta o millas distintas (el tramo se redefinió) ⇒ NO se ancla', () => {
    const otraRuta = anclarTramoAlCotizado(
      {
        origen_iata: 'CZM',
        destino_iata: 'CUN',
        millas_nauticas: 127.5,
        pasajeros: 4,
      },
      COTIZADO_326[1],
      VIVA_2,
      {},
    );
    expect(otraRuta.anclado).toEqual([]);
    const otrasMillas = anclarTramoAlCotizado(
      {
        origen_iata: 'PTU',
        destino_iata: 'CUN',
        millas_nauticas: 200,
        pasajeros: 4,
      },
      COTIZADO_326[1],
      VIVA_2,
      {},
    );
    expect(otrasMillas.anclado).toEqual([]);
  });

  it('sin tramo cotizado o sin escala viva ⇒ devuelve el entrante intacto', () => {
    const leg = {
      origen_iata: 'PTU',
      destino_iata: 'CUN',
      millas_nauticas: 127.5,
      pasajeros: 4,
    };
    expect(anclarTramoAlCotizado(leg, undefined, VIVA_2).leg).toBe(leg);
    expect(anclarTramoAlCotizado(leg, COTIZADO_326[1], undefined).leg).toBe(
      leg,
    );
  });

  it('#320: la pernocta que puso la operación no entra al precio', () => {
    const cotizado: TramoCotizado = {
      ...COTIZADO_326[1],
      origen_iata: 'CZM',
      destino_iata: 'CUN',
      es_ferry: true,
      pasajeros: 0,
    };
    const r = anclarTramoAlCotizado(
      {
        origen_iata: 'CZM',
        destino_iata: 'CUN',
        millas_nauticas: 127.5,
        es_ferry: true,
        requiere_pernocta: true,
        pernocta_costo_usd: 150,
      },
      cotizado,
      {
        origen_iata: 'CZM',
        destino_iata: 'CUN',
        es_ferry: true,
        requiere_pernocta: true,
      },
      {},
    );
    expect(r.anclado).toEqual(['pernocta']);
    expect(r.leg.requiere_pernocta).toBe(false);
    expect(r.leg.pernocta_costo_usd).toBeNull();
  });

  it('no muta el tramo entrante (helper PURO)', () => {
    const leg = {
      origen_iata: 'PTU',
      destino_iata: 'CUN',
      millas_nauticas: 127.5,
      pasajeros: 4,
      es_ferry: false,
    };
    const r = anclarTramoAlCotizado(leg, COTIZADO_326[1], VIVA_2, {});
    expect(leg.pasajeros).toBe(4);
    expect(r.leg.pasajeros).toBe(2);
  });
});

describe('columnasQueConservaLaOperacion — qué NO pisa el UPDATE', () => {
  /** Tramo ya resuelto por el motor, idéntico a lo cotizado. */
  const igualAlCotizado = {
    origen_iata: 'PTU',
    destino_iata: 'CUN',
    pasajeros: 2,
    pasajeros_nombres: [],
    es_ferry: false,
    requiere_pernocta: false,
    pernocta_costo_usd: 0,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    notas: null,
  };

  it('todo igual a lo cotizado ⇒ se omiten TODAS las columnas de la operación', () => {
    expect(
      columnasQueConservaLaOperacion(igualAlCotizado, COTIZADO_326[1]).sort(),
    ).toEqual([
      'es_ferry',
      'notas',
      'pasajeros',
      'pasajeros_nombres',
      'pernocta_costo_usd',
      'requiere_pernocta',
      'servicio_notas',
      'tipo_parada',
    ]);
  });

  it('la oficina cambió el pax ⇒ pasajeros SÍ se escribe (edición deliberada)', () => {
    const omitidas = columnasQueConservaLaOperacion(
      { ...igualAlCotizado, pasajeros: 6 },
      COTIZADO_326[1],
    );
    expect(omitidas).not.toContain('pasajeros');
    expect(omitidas).toContain('es_ferry');
  });

  it('la oficina marcó ferry ⇒ es_ferry y pasajeros se escriben juntos', () => {
    const omitidas = columnasQueConservaLaOperacion(
      { ...igualAlCotizado, es_ferry: true, pasajeros: 0 },
      COTIZADO_326[1],
    );
    expect(omitidas).not.toContain('es_ferry');
    expect(omitidas).not.toContain('pasajeros');
  });

  it('el manifiesto se decide APARTE del pax (el cotizador sí lo edita)', () => {
    const conNombres = columnasQueConservaLaOperacion(
      { ...igualAlCotizado, pasajeros_nombres: ['Ana', 'Luis'] },
      COTIZADO_326[1],
    );
    expect(conNombres).toContain('pasajeros');
    expect(conNombres).not.toContain('pasajeros_nombres');
  });

  it('pernocta: el costo viaja PEGADO a la bandera', () => {
    const omitidas = columnasQueConservaLaOperacion(
      { ...igualAlCotizado, requiere_pernocta: true, pernocta_costo_usd: 150 },
      COTIZADO_326[1],
    );
    expect(omitidas).not.toContain('requiere_pernocta');
    expect(omitidas).not.toContain('pernocta_costo_usd');
  });

  it('notas del tramo: la nota del piloto se conserva cuando la cotización no la cambia', () => {
    expect(
      columnasQueConservaLaOperacion(
        { ...igualAlCotizado, notas: '   ' },
        COTIZADO_326[1],
      ),
    ).toContain('notas');
    expect(
      columnasQueConservaLaOperacion(
        { ...igualAlCotizado, notas: 'Cargar gasolina aquí' },
        COTIZADO_326[1],
      ),
    ).not.toContain('notas');
  });
});

describe('textos de los avisos ámbar', () => {
  it('el ancla nunca es silenciosa', () => {
    expect(avisoAnclaDeTramos([])).toBeNull();
    const txt = avisoAnclaDeTramos([
      { orden: 1, campos: ['es_ferry', 'pasajeros'] },
    ])!;
    expect(txt).toContain('tramo 1');
    expect(txt).toContain('la marca de ferry');
    expect(txt).toContain('los pasajeros');
    expect(txt).toContain('PACTADO');
  });

  it('tramo cancelado y tramo con taco', () => {
    expect(avisoTramoCancelado(2, rutaTxt(VIVA_2))).toContain(
      'PTU → CUN está CANCELADO',
    );
    expect(avisoTramoConTacoConservado(3, 'PTU → CZM')).toContain(
      'tacómetro capturado',
    );
  });
});
