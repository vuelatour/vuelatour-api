/**
 * «PASAR ESTOS TRAMOS AL VUELO» (17-nov-2026, invariante 136, caso #478):
 * la regla PURA — cuándo se puede, qué tramos se escriben y qué se dice.
 *
 * Los datos del caso son los REALES de prod (lectura del 17-nov-2026): el
 * vuelo #478 nació el 23-oct como RESERVA con UN tramo CUN → MHL de 0
 * pasajeros y se cotizó el 17-nov como CUN → CTM → MHL → CTM → CUN.
 */
import {
  CODIGOS_TRAMOS_AL_VUELO,
  MENSAJE_TRAMOS_AL_VUELO,
  avisoHoraDeSalidaDistinta,
  avisoTripulacionTramosAlVuelo,
  evaluarTramosAlVuelo,
  fechaHoraCancun,
  rutaEnTexto,
  selloTramosAlVuelo,
  tramosDelSnapshotParaVuelo,
  tramosVivosDelVuelo,
  type EntradaTramosAlVuelo,
} from './tramos-al-vuelo.util';

/** `calculo_snapshot.ruta.escalas` del #478 tal como quedó en la v3. */
const SNAPSHOT_478 = {
  ruta: {
    escalas: [
      {
        notas: null,
        es_ferry: false,
        pasajeros: 4,
        pdf_oculto: null,
        origen_iata: 'CUN',
        tipo_parada: 'NORMAL',
        destino_iata: 'CTM',
        servicio_notas: null,
        millas_nauticas: 173,
        fecha_salida_plan: '2026-11-18T15:00:00.000Z',
        pasajeros_nombres: [],
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
      },
      {
        notas: null,
        es_ferry: false,
        pasajeros: 6,
        pdf_oculto: null,
        origen_iata: 'CTM',
        tipo_parada: 'NORMAL',
        destino_iata: 'MHL',
        servicio_notas: null,
        millas_nauticas: 38.82,
        fecha_salida_plan: '2026-11-18T17:00:00.000Z',
        pasajeros_nombres: [],
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
      },
      {
        notas: null,
        es_ferry: false,
        pasajeros: 2,
        pdf_oculto: null,
        origen_iata: 'MHL',
        tipo_parada: 'NORMAL',
        destino_iata: 'CTM',
        servicio_notas: null,
        millas_nauticas: 38.82,
        fecha_salida_plan: null,
        pasajeros_nombres: [],
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
      },
      {
        notas: null,
        es_ferry: true,
        pasajeros: 0,
        pdf_oculto: null,
        origen_iata: 'CTM',
        tipo_parada: 'NORMAL',
        destino_iata: 'CUN',
        servicio_notas: null,
        millas_nauticas: 173,
        fecha_salida_plan: null,
        pasajeros_nombres: [],
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
      },
    ],
  },
};

/** La única escala viva del #478 (la de la reserva). */
const ESCALA_RESERVA = {
  orden: 1,
  origen_iata: 'CUN',
  destino_iata: 'MHL',
  taco_salida: null,
  taco_llegada: null,
  cancelada_at: null,
  solo_operativa: false,
};

function vuelo478(
  extra: Partial<EntradaTramosAlVuelo> = {},
): EntradaTramosAlVuelo {
  return {
    estado: 'CONFIRMADO',
    itinerario_operativo: true,
    calculo_snapshot: SNAPSHOT_478,
    combinado_con_id: null,
    grupo_id: null,
    escalas: [ESCALA_RESERVA],
    ...extra,
  };
}

describe('caso #478: reserva CUN → MHL cotizada después con cuatro tramos', () => {
  it('se puede: devuelve los 4 tramos cotizados y las dos rutas en palabras', () => {
    const ev = evaluarTramosAlVuelo(vuelo478());
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.rutaCotizada).toBe('CUN → CTM → MHL → CTM → CUN');
    expect(ev.rutaVuelo).toBe('CUN → MHL');
    expect(
      ev.tramos.map(
        (t) =>
          `${t.origen_iata}-${t.destino_iata}:${t.pasajeros}:${t.es_ferry ? 'ferry' : 'pax'}`,
      ),
    ).toEqual([
      'CUN-CTM:4:pax',
      'CTM-MHL:6:pax',
      'MHL-CTM:2:pax',
      'CTM-CUN:0:ferry',
    ]);
    // La hora de cada tramo viaja tal cual se guardó en la cotización.
    expect(ev.tramos.map((t) => t.fecha_salida_plan)).toEqual([
      '2026-11-18T15:00:00.000Z',
      '2026-11-18T17:00:00.000Z',
      null,
      null,
    ]);
    expect(ev.tramos.map((t) => t.millas_nauticas)).toEqual([
      173, 38.82, 38.82, 173,
    ]);
    // La visibilidad del PDF es de la escala viva: nunca viaja.
    expect(ev.tramos.every((t) => t.pdf_oculto === null)).toBe(true);
    expect(ev.tramos.every((t) => !('pdf_fecha' in t))).toBe(true);
  });

  it('el aviso de hora: el vuelo decía 08:00 y el tramo 1 cotizado 10:00 (hora Cancún)', () => {
    const aviso = avisoHoraDeSalidaDistinta(
      '2026-11-18T13:00:00+00:00',
      '2026-11-18T15:00:00.000Z',
    );
    expect(aviso).toContain('18/11/2026 10:00');
    expect(aviso).toContain('18/11/2026 08:00');
    expect(aviso).toContain('hora Cancún');
  });
});

describe('candados: cuándo NO se pasan los tramos (409 con su código)', () => {
  const codigo = (v: EntradaTramosAlVuelo) => {
    const ev = evaluarTramosAlVuelo(v);
    return ev.ok ? 'OK' : ev.code;
  };

  it('el vuelo ya sigue la cotización (no es ruta operativa)', () => {
    expect(codigo(vuelo478({ itinerario_operativo: false }))).toBe(
      'VUELO_YA_SIGUE_COTIZACION',
    );
    expect(codigo(vuelo478({ itinerario_operativo: null }))).toBe(
      'VUELO_YA_SIGUE_COTIZACION',
    );
  });

  it('cancelado', () => {
    expect(codigo(vuelo478({ estado: 'CANCELADO' }))).toBe('VUELO_CANCELADO');
  });

  it.each(['EN_VUELO', 'COMPLETADO'])('ya voló por estado: %s', (estado) => {
    expect(codigo(vuelo478({ estado }))).toBe('VUELO_YA_VOLO');
  });

  it('ya voló por un tacómetro capturado (aunque siga CONFIRMADO; un 0 cuenta)', () => {
    expect(
      codigo(
        vuelo478({ escalas: [{ ...ESCALA_RESERVA, taco_salida: 5599.4 }] }),
      ),
    ).toBe('VUELO_YA_VOLO');
    expect(
      codigo(vuelo478({ escalas: [{ ...ESCALA_RESERVA, taco_llegada: 0 }] })),
    ).toBe('VUELO_YA_VOLO');
  });

  it('un tramo CANCELADO con tacómetro no hace volado al vuelo', () => {
    expect(
      codigo(
        vuelo478({
          escalas: [
            ESCALA_RESERVA,
            {
              ...ESCALA_RESERVA,
              orden: 2,
              taco_salida: 100,
              cancelada_at: '2026-11-01T00:00:00Z',
            },
          ],
        }),
      ),
    ).toBe('OK');
  });

  it('combinado con otro vuelo y avión de un grupo', () => {
    expect(codigo(vuelo478({ combinado_con_id: 'otro' }))).toBe(
      'VUELO_COMBINADO',
    );
    expect(codigo(vuelo478({ grupo_id: 'g-12' }))).toBe('VUELO_DE_GRUPO');
  });

  it('sin tramos cotizados: sin snapshot, lista vacía o un tramo sin origen', () => {
    expect(codigo(vuelo478({ calculo_snapshot: null }))).toBe(
      'SIN_TRAMOS_COTIZADOS',
    );
    expect(
      codigo(vuelo478({ calculo_snapshot: { ruta: { escalas: [] } } })),
    ).toBe('SIN_TRAMOS_COTIZADOS');
    expect(
      codigo(
        vuelo478({
          calculo_snapshot: {
            ruta: { escalas: [{ origen_iata: '', destino_iata: 'CTM' }] },
          },
        }),
      ),
    ).toBe('SIN_TRAMOS_COTIZADOS');
  });

  it('el orden de los candados: primero lo que hace innecesaria la acción', () => {
    // No operativo Y cancelado Y sin snapshot ⇒ «ya sigue la cotización».
    expect(
      codigo(
        vuelo478({
          itinerario_operativo: false,
          estado: 'CANCELADO',
          calculo_snapshot: null,
        }),
      ),
    ).toBe('VUELO_YA_SIGUE_COTIZACION');
    // Volado gana a combinado: lo volado no se toca por ningún lado.
    expect(
      codigo(vuelo478({ estado: 'COMPLETADO', combinado_con_id: 'x' })),
    ).toBe('VUELO_YA_VOLO');
  });

  it('cada código tiene su mensaje en es-MX, sin tecnicismos', () => {
    for (const c of CODIGOS_TRAMOS_AL_VUELO) {
      expect(MENSAJE_TRAMOS_AL_VUELO[c].length).toBeGreaterThan(20);
      expect(MENSAJE_TRAMOS_AL_VUELO[c]).not.toMatch(
        /itinerario_operativo|snapshot/,
      );
    }
  });
});

describe('tramosDelSnapshotParaVuelo: normaliza lo que se guardó', () => {
  it('ferry ⇒ 0 pasajeros y sin nombres; sin pernocta ⇒ costo 0', () => {
    const t = tramosDelSnapshotParaVuelo({
      ruta: {
        escalas: [
          {
            origen_iata: 'cun',
            destino_iata: ' czm ',
            es_ferry: true,
            pasajeros: 5,
            pasajeros_nombres: ['Ana'],
            requiere_pernocta: false,
            pernocta_costo_usd: 150,
            millas_nauticas: '38.5',
            tipo_parada: 'SERVICIO',
            servicio_notas: ' llanta ',
            fecha_salida_plan: 'no-es-fecha',
          },
        ],
      },
    });
    expect(t).toEqual([
      {
        origen_iata: 'CUN',
        destino_iata: 'CZM',
        millas_nauticas: 38.5,
        pasajeros: 0,
        pasajeros_nombres: [],
        es_ferry: true,
        requiere_pernocta: false,
        pernocta_costo_usd: 0,
        tipo_parada: 'SERVICIO',
        servicio_notas: 'llanta',
        notas: null,
        fecha_salida_plan: null,
        pdf_oculto: null,
      },
    ]);
  });

  it('con pernocta conserva su costo y los nombres del manifiesto', () => {
    const t = tramosDelSnapshotParaVuelo({
      ruta: {
        escalas: [
          {
            origen_iata: 'CUN',
            destino_iata: 'HOL',
            pasajeros: 3,
            pasajeros_nombres: ['Ana', ' ', 'Luis'],
            requiere_pernocta: true,
            pernocta_costo_usd: 120,
          },
        ],
      },
    });
    expect(t?.[0]).toMatchObject({
      pasajeros: 3,
      pasajeros_nombres: ['Ana', 'Luis'],
      requiere_pernocta: true,
      pernocta_costo_usd: 120,
    });
  });
});

describe('textos', () => {
  it('rutaEnTexto: encadenada, tramo por tramo y vacía', () => {
    expect(
      rutaEnTexto([
        { origen_iata: 'CUN', destino_iata: 'CTM' },
        { origen_iata: 'CTM', destino_iata: 'CUN' },
      ]),
    ).toBe('CUN → CTM → CUN');
    expect(
      rutaEnTexto([
        { origen_iata: 'CUN', destino_iata: 'MHL' },
        { origen_iata: 'CZM', destino_iata: 'CUN' },
      ]),
    ).toBe('CUN → MHL · CZM → CUN');
    expect(rutaEnTexto([])).toBe('—');
  });

  it('tramosVivosDelVuelo: sin cancelados ni operativos internos, por orden', () => {
    const vivos = tramosVivosDelVuelo([
      { orden: 2, origen_iata: 'B', destino_iata: 'C' },
      { orden: 1, origen_iata: 'A', destino_iata: 'B' },
      { orden: 3, origen_iata: 'C', destino_iata: 'D', cancelada_at: 'x' },
      { orden: 100, origen_iata: 'X', destino_iata: 'Y', solo_operativa: true },
    ]);
    expect(rutaEnTexto(vivos)).toBe('A → B → C');
  });

  it('fechaHoraCancun: UTC−5 fijo, también al cruzar la medianoche', () => {
    expect(fechaHoraCancun('2026-11-18T15:00:00.000Z')).toBe(
      '18/11/2026 10:00',
    );
    expect(fechaHoraCancun('2026-11-18T03:30:00.000Z')).toBe(
      '17/11/2026 22:30',
    );
  });

  it('avisoHoraDeSalidaDistinta: null si coinciden o falta alguna', () => {
    expect(
      avisoHoraDeSalidaDistinta(
        '2026-11-18T13:00:00+00:00',
        '2026-11-18T13:00:00.000Z',
      ),
    ).toBeNull();
    expect(
      avisoHoraDeSalidaDistinta(null, '2026-11-18T13:00:00.000Z'),
    ).toBeNull();
    expect(
      avisoHoraDeSalidaDistinta('2026-11-18T13:00:00.000Z', null),
    ).toBeNull();
  });

  it('sello de auditoría: quién, cuándo, versión y las dos rutas', () => {
    expect(
      selloTramosAlVuelo({
        cuandoIso: '2026-11-17T20:15:00.000Z',
        quien: 'Itzi',
        version: 3,
        antes: 'CUN → MHL',
        ahora: 'CUN → CTM → MHL → CTM → CUN',
      }),
    ).toBe(
      '[Tramos de la cotización al vuelo] 17/11/2026 15:15 · Itzi: el vuelo tomó los tramos de la cotización v3 (CUN → CTM → MHL → CTM → CUN); antes tenía CUN → MHL.',
    );
    expect(
      selloTramosAlVuelo({
        cuandoIso: '2026-11-17T20:15:00.000Z',
        quien: null,
        version: null,
        antes: '—',
        ahora: 'CUN → HOL → CUN',
      }),
    ).toBe(
      '[Tramos de la cotización al vuelo] 17/11/2026 15:15: el vuelo tomó los tramos de la cotización (CUN → HOL → CUN); antes tenía —.',
    );
  });

  it('aviso a la tripulación: UNO, con la ruta completa nueva', () => {
    expect(
      avisoTripulacionTramosAlVuelo({
        folio: 478,
        antes: 'CUN → MHL',
        ahora: 'CUN → CTM → MHL → CTM → CUN',
      }),
    ).toEqual({
      titulo: 'Vuelo #478: cambió el itinerario',
      cuerpo:
        'Ahora es CUN → CTM → MHL → CTM → CUN (antes CUN → MHL). Revisa tus tramos y horarios.',
    });
  });
});
