/**
 * QUITAR UNA ESCALA INTERMEDIA QUE NO SE HIZO (2-nov-2026, invariante 113):
 * regla pura de la fusión de dos tramos. Datos del caso real #496 (Pablo,
 * 29-oct-2026): CUN→HOL→TQO→CUN volado como CUN→TQO→CUN.
 */
import {
  descripcionLlegada,
  fusionarTramos,
  porQueNoSeQuitaEscala,
  selloEscalaQuitada,
  textoAvisoEscalaQuitada,
  type TramoFusionable,
} from './escala-quitada.util';

const V = '719e4aab-20a6-4b6e-b2f1-95ad34a5f261';
const PABLO = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1';
const ALE = '5391362f-e8cc-4287-95ef-739911fbf0e5';
const AVION = 'e1a85e5b-9eaa-4367-9920-68d5d78883e8';

/** Tramo 1 del #496: CUN→HOL con salida y «llegada» (que en realidad fue a TQO). */
function tramoA(extra: Partial<TramoFusionable> = {}): TramoFusionable {
  return {
    id: 'a',
    vuelo_id: V,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    aeronave_id: AVION,
    estado_permiso: 'emitido',
    pasajeros: 4,
    pasajeros_nombres: ['Ana', 'Beto'],
    es_ferry: false,
    requiere_pernocta: false,
    pernocta_costo_usd: null,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    solo_operativa: false,
    taco_salida: '1680.6',
    taco_llegada: '1682.3',
    taco_salida_origen: 'PILOTO',
    taco_llegada_origen: 'PILOTO',
    foto_taco_salida_url: 'taco/salida-a.jpg',
    foto_taco_llegada_url: null,
    valor_ia_propuesto: null,
    revision_motivo:
      'Duración 102 min fuera de rango histórico (~32 min); Registro: salida capturada por Pablo Canales · llegada capturada por Pablo Canales',
    hora_salida: '2026-10-29T18:02:38.789+00:00',
    hora_llegada: '2026-10-29T18:28:00.687+00:00',
    capturado_offline: false,
    sincronizado_at: '2026-10-29T18:28:01.03+00:00',
    capturado_por: PABLO,
    notas: null,
    cancelada_at: null,
    monto_externo_usd: null,
    taco_omitido_at: null,
    taco_omitido_por: null,
    taco_omitido_motivo: null,
    ...extra,
  };
}

/** Tramo 2 del #496: HOL→TQO, sin salida (retirada) y con la llegada real a TQO. */
function tramoB(extra: Partial<TramoFusionable> = {}): TramoFusionable {
  return {
    id: 'b',
    vuelo_id: V,
    orden: 2,
    origen_iata: 'HOL',
    destino_iata: 'TQO',
    aeronave_id: AVION,
    estado_permiso: 'emitido',
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
    requiere_pernocta: true,
    pernocta_costo_usd: '120',
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    solo_operativa: false,
    taco_salida: null,
    taco_llegada: '1682.3',
    taco_salida_origen: null,
    taco_llegada_origen: 'PILOTO',
    foto_taco_salida_url: null,
    foto_taco_llegada_url: 'taco/llegada-b.jpg',
    valor_ia_propuesto: null,
    revision_motivo:
      'Salida estimada retirada: la llegada real (1682.3) la contradecía — confirmar salida en oficina',
    hora_salida: null,
    hora_llegada: '2026-10-30T00:49:50.143+00:00',
    capturado_offline: true,
    sincronizado_at: '2026-10-30T00:49:50.637+00:00',
    capturado_por: PABLO,
    notas: 'FBO Tulum',
    cancelada_at: null,
    monto_externo_usd: null,
    taco_omitido_at: null,
    taco_omitido_por: null,
    taco_omitido_motivo: null,
    ...extra,
  };
}

const VUELO = { estado: 'COMPLETADO', aeronave_id: AVION };
const OPTS = {
  ahora: '2026-11-02T20:15:00.000Z',
  quien: 'Ale',
  userId: ALE,
  omitidoOk: true,
};

describe('porQueNoSeQuitaEscala · cuándo NO se fusiona', () => {
  it('A y B continuos, activos, comerciales y del mismo avión ⇒ null (sí se puede)', () => {
    expect(porQueNoSeQuitaEscala(tramoA(), tramoB(), VUELO)).toBeNull();
    // Avión heredado del vuelo en los dos tramos: mismo avión.
    expect(
      porQueNoSeQuitaEscala(
        tramoA({ aeronave_id: null }),
        tramoB({ aeronave_id: null }),
        VUELO,
      ),
    ).toBeNull();
    // Uno propio y el otro heredado, pero el mismo id: también.
    expect(
      porQueNoSeQuitaEscala(tramoA({ aeronave_id: null }), tramoB(), VUELO),
    ).toBeNull();
  });

  it('tramo cancelado ⇒ ESCALA_CANCELADA (antes que cualquier otra cosa)', () => {
    const r = porQueNoSeQuitaEscala(
      tramoA({ cancelada_at: '2026-10-30T00:00:00Z' }),
      null,
      { estado: 'CANCELADO' },
    );
    expect(r?.code).toBe('ESCALA_CANCELADA');
    expect(r?.details).toEqual({
      escala_id: 'a',
      cancelada_at: '2026-10-30T00:00:00Z',
    });
  });

  it('vuelo CANCELADO ⇒ VUELO_CANCELADO', () => {
    const r = porQueNoSeQuitaEscala(tramoA(), tramoB(), {
      estado: 'CANCELADO',
      aeronave_id: AVION,
    });
    expect(r?.code).toBe('VUELO_CANCELADO');
    expect(r?.message).toMatch(/restáuralo antes/);
  });

  it('último tramo activo ⇒ ESCALA_FINAL (el destino se corrige con «Editar tramo»)', () => {
    const r = porQueNoSeQuitaEscala(tramoA(), null, VUELO);
    expect(r?.code).toBe('ESCALA_FINAL');
    expect(r?.message).toContain('Si el vuelo no llegó a HOL');
    expect(r?.details).toEqual({ escala_id: 'a', destino_iata: 'HOL' });
  });

  it('B no sale de donde llega A ⇒ ESCALA_NO_ENLAZA', () => {
    const r = porQueNoSeQuitaEscala(
      tramoA(),
      tramoB({ origen_iata: 'MID' }),
      VUELO,
    );
    expect(r?.code).toBe('ESCALA_NO_ENLAZA');
    expect(r?.message).toContain('sale de MID, no de HOL');
    expect(r?.details).toMatchObject({
      destino_iata: 'HOL',
      siguiente_origen_iata: 'MID',
    });
  });

  it('A o B operativos (ferry / parada técnica, orden ≥ 100) ⇒ ESCALA_OPERATIVA', () => {
    expect(
      porQueNoSeQuitaEscala(tramoA({ solo_operativa: true }), tramoB(), VUELO)
        ?.code,
    ).toBe('ESCALA_OPERATIVA');
    const r = porQueNoSeQuitaEscala(
      tramoA(),
      tramoB({ solo_operativa: true, orden: 100 }),
      VUELO,
    );
    expect(r?.code).toBe('ESCALA_OPERATIVA');
    expect(r?.details).toMatchObject({ operativa_a: false, operativa_b: true });
  });

  it('aviones distintos (con herencia del vuelo) ⇒ ESCALAS_DISTINTO_AVION', () => {
    const r = porQueNoSeQuitaEscala(
      tramoA({ aeronave_id: null }),
      tramoB({ aeronave_id: 'otro-avion' }),
      VUELO,
    );
    expect(r?.code).toBe('ESCALAS_DISTINTO_AVION');
    expect(r?.details).toMatchObject({
      aeronave_a: AVION,
      aeronave_b: 'otro-avion',
    });
  });
});

describe('fusionarTramos · el tramo fusionado (caso #496)', () => {
  it('conserva la salida de A, toma la llegada y la parada de B, descarta la llegada a HOL y queda en amarillo', () => {
    const f = fusionarTramos(tramoA(), tramoB(), OPTS);
    expect(f.origen_iata).toBe('CUN');
    expect(f.destino_iata).toBe('TQO');
    expect(f.escala_iata).toBe('HOL');
    expect(f.salida_retirada).toBe(false);
    // Lo del DESTINO viene de B.
    expect(f.patch).toMatchObject({
      destino_iata: 'TQO',
      estado_permiso: 'emitido',
      hora_llegada: '2026-10-30T00:49:50.143+00:00',
      taco_llegada: '1682.3',
      taco_llegada_origen: 'PILOTO',
      foto_taco_llegada_url: 'taco/llegada-b.jpg',
      taco_llegada_obs: null,
      requiere_pernocta: true,
      pernocta_costo_usd: '120',
      tipo_parada: 'NORMAL',
      servicio_notas: null,
      capturado_por: PABLO,
      capturado_offline: true,
      sincronizado_at: '2026-10-30T00:49:50.637+00:00',
      pasajeros: 4,
      pasajeros_nombres: ['Ana', 'Beto'],
      es_ferry: false,
      notas: 'FBO Tulum',
      monto_externo_usd: null,
      revision_requerida: true,
      updated_by: ALE,
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
    });
    // Lo del ORIGEN (salida) NO se toca: no viaja en el patch.
    for (const k of [
      'taco_salida',
      'taco_salida_origen',
      'hora_salida',
      'foto_taco_salida_url',
      'orden',
      'origen_iata',
      'fecha_salida_plan',
      'piloto_id',
      'aeronave_id',
      'google_calendar_id',
    ]) {
      expect(f.patch).not.toHaveProperty(k);
    }
    // Motivo: la alerta al frente, la bitácora previa de A conservada y la
    // línea de la fusión con las dos llegadas (hora Cancún).
    const motivo = f.patch.revision_motivo as string;
    expect(motivo.startsWith(f.alerta)).toBe(true);
    expect(f.alerta).toBe(
      'Escala en HOL quitada (no se aterrizó): tramos CUN→HOL y HOL→TQO fusionados en CUN→TQO; revisar salida, llegada y tacómetro en oficina',
    );
    expect(motivo).toContain(
      'Registro: salida capturada por Pablo Canales · llegada capturada por Pablo Canales · escala HOL quitada el 2026-11-02 15:15 por Ale: llegada a HOL descartada (taco 1682.3 (PILOTO) a las 2026-10-29 13:28) · llegada a TQO tomada del tramo HOL→TQO (taco 1682.3 (PILOTO) a las 2026-10-29 19:49 con foto)',
    );
    // La alerta vieja de A («Duración 102 min…») y la de B («Salida estimada
    // retirada…») ya no aplican al tramo fusionado: no se arrastran.
    expect(motivo).not.toContain('Duración 102 min');
    expect(motivo).not.toContain('Salida estimada retirada');
    expect(f.descartada).toEqual({
      hora_llegada: '2026-10-29T18:28:00.687+00:00',
      taco_llegada: 1682.3,
      taco_llegada_origen: 'PILOTO',
      con_foto: false,
    });
    expect(f.aviso).toBe(
      'La llegada a HOL capturada (taco 1682.3 (PILOTO) a las 2026-10-29 13:28) se descartó: queda en la bitácora del tramo.',
    );
    expect(f.resumen).toContain(
      'CUN→HOL + HOL→TQO ⇒ CUN→TQO; escala HOL quitada el 2026-11-02 15:15 por Ale',
    );
  });

  it('una corrección a la baja PENDIENTE de B viaja con su llegada; la bitácora de B se agrega', () => {
    const f = fusionarTramos(
      tramoA(),
      tramoB({
        revision_motivo:
          'Corrección a la baja pendiente de oficina: llegada 1686.8 → 1682.3; Registro: llegada capturada por Pablo Canales · corregida a la baja',
      }),
      OPTS,
    );
    const motivo = f.patch.revision_motivo as string;
    expect(motivo).toContain(
      'Corrección a la baja pendiente de oficina: llegada 1686.8 → 1682.3',
    );
    expect(motivo).toContain(
      'del tramo HOL→TQO: llegada capturada por Pablo Canales · corregida a la baja',
    );
  });

  it('CHECK llegada > salida: si la llegada de B no supera la salida de A, la salida se retira en amarillo', () => {
    const f = fusionarTramos(
      tramoA({ taco_salida: '1682.5', taco_salida_origen: 'PILOTO' }),
      tramoB({ taco_llegada: '1682.3' }),
      OPTS,
    );
    expect(f.salida_retirada).toBe(true);
    expect(f.patch).toMatchObject({
      taco_salida: null,
      taco_salida_origen: null,
      taco_llegada: '1682.3',
    });
    expect(f.patch.revision_motivo).toContain(
      'salida 1682.5 retirada: no cabe bajo la llegada 1682.3',
    );
    expect(f.aviso).toContain(
      'La salida 1682.5 del tramo no cabía bajo la llegada 1682.3: se retiró',
    );
    // Igual (<=) también retira; mayor NO.
    expect(
      fusionarTramos(
        tramoA({ taco_salida: '1682.3' }),
        tramoB({ taco_llegada: '1682.3' }),
        OPTS,
      ).salida_retirada,
    ).toBe(true);
    expect(
      fusionarTramos(
        tramoA({ taco_salida: '1680.6' }),
        tramoB({ taco_llegada: '1680.7' }),
        OPTS,
      ).salida_retirada,
    ).toBe(false);
  });

  it('sin salida en A o sin llegada en B no hay nada que retirar; sin llegada en A no hay aviso', () => {
    const f = fusionarTramos(
      tramoA({
        taco_salida: null,
        taco_salida_origen: null,
        taco_llegada: null,
        taco_llegada_origen: null,
        hora_llegada: null,
        revision_motivo: null,
      }),
      tramoB({ revision_motivo: null }),
      OPTS,
    );
    expect(f.salida_retirada).toBe(false);
    expect(f.aviso).toBeNull();
    expect(f.descartada).toEqual({
      hora_llegada: null,
      taco_llegada: null,
      taco_llegada_origen: null,
      con_foto: false,
    });
    expect(f.patch.revision_motivo).toContain(
      'llegada a HOL descartada (sin lectura)',
    );
  });

  it('pasajeros: el mayor de los dos y la unión del manifiesto; ferry solo si los dos lo eran', () => {
    const f = fusionarTramos(
      tramoA({ pasajeros: 2, pasajeros_nombres: ['Ana'] }),
      tramoB({ pasajeros: 3, pasajeros_nombres: ['Ana', 'Caro'] }),
      OPTS,
    );
    expect(f.patch).toMatchObject({
      pasajeros: 3,
      pasajeros_nombres: ['Ana', 'Caro'],
      es_ferry: false,
    });
    const ferry = fusionarTramos(
      tramoA({ es_ferry: true, pasajeros: 0, pasajeros_nombres: [] }),
      tramoB({ es_ferry: true, pasajeros: 0, pasajeros_nombres: [] }),
      OPTS,
    );
    expect(ferry.patch).toMatchObject({
      pasajeros: 0,
      pasajeros_nombres: [],
      es_ferry: true,
    });
    // Un solo ferry ⇒ el tramo fusionado va con pasajeros (los que subían).
    const mixto = fusionarTramos(
      tramoA({ es_ferry: true, pasajeros: 0, pasajeros_nombres: [] }),
      tramoB({ pasajeros: 2, pasajeros_nombres: ['Dani'] }),
      OPTS,
    );
    expect(mixto.patch).toMatchObject({
      pasajeros: 2,
      pasajeros_nombres: ['Dani'],
      es_ferry: false,
    });
    // Ninguno trae pasajeros ⇒ null (no se inventa 0).
    expect(
      fusionarTramos(
        tramoA({ pasajeros: null, pasajeros_nombres: null }),
        tramoB({ pasajeros: null, pasajeros_nombres: null }),
        OPTS,
      ).patch.pasajeros,
    ).toBeNull();
  });

  it('notas se unen, el costo externo se suma, la observación de llegada de B trae su sello', () => {
    const f = fusionarTramos(
      tramoA({
        notas: 'Salida con retraso',
        monto_externo_usd: '100.5',
        taco_obs_updated_at: '2026-10-29T19:00:00Z',
        taco_obs_updated_by: ALE,
      }),
      tramoB({
        notas: 'FBO Tulum',
        monto_externo_usd: 50,
        taco_llegada_obs: 'Aguja borrosa',
        taco_obs_updated_at: '2026-10-30T01:00:00Z',
        taco_obs_updated_by: PABLO,
      }),
      OPTS,
    );
    expect(f.patch).toMatchObject({
      notas: 'Salida con retraso · FBO Tulum',
      monto_externo_usd: 150.5,
      taco_llegada_obs: 'Aguja borrosa',
      taco_obs_updated_at: '2026-10-30T01:00:00Z',
      taco_obs_updated_by: PABLO,
    });
    // Sin observación de llegada en B, el sello de A no se toca.
    const sin = fusionarTramos(
      tramoA({ taco_obs_updated_at: '2026-10-29T19:00:00Z' }),
      tramoB(),
      OPTS,
    );
    expect(sin.patch).not.toHaveProperty('taco_obs_updated_at');
  });

  it('tacómetro omitido: la omisión de B sobrevive (su llegada es la que queda); la de A cae; sin columnas no viaja', () => {
    const conOmision = fusionarTramos(
      tramoA({
        taco_llegada: null,
        taco_llegada_origen: null,
        taco_omitido_at: '2026-10-29T20:00:00Z',
        taco_omitido_por: ALE,
        taco_omitido_motivo: 'Horómetro apagado en Holbox',
      }),
      tramoB({
        taco_llegada: null,
        taco_llegada_origen: null,
        foto_taco_llegada_url: null,
        taco_omitido_at: '2026-10-30T02:00:00Z',
        taco_omitido_por: ALE,
        taco_omitido_motivo: 'Sin foto del horómetro en Tulum',
      }),
      OPTS,
    );
    expect(conOmision.patch).toMatchObject({
      taco_llegada: null,
      taco_omitido_at: '2026-10-30T02:00:00Z',
      taco_omitido_motivo: 'Sin foto del horómetro en Tulum',
    });
    const sinColumnas = fusionarTramos(tramoA(), tramoB(), {
      ...OPTS,
      omitidoOk: false,
    });
    expect(sinColumnas.patch).not.toHaveProperty('taco_omitido_at');
  });
});

describe('textos', () => {
  it('descripcionLlegada', () => {
    expect(descripcionLlegada(tramoA())).toBe(
      'taco 1682.3 (PILOTO) a las 2026-10-29 13:28',
    );
    expect(descripcionLlegada(tramoB())).toBe(
      'taco 1682.3 (PILOTO) a las 2026-10-29 19:49 con foto',
    );
    expect(
      descripcionLlegada(
        tramoA({
          taco_llegada: null,
          hora_llegada: null,
          taco_llegada_origen: null,
        }),
      ),
    ).toBe('sin lectura');
  });

  it('sello de notas internas y aviso a la tripulación', () => {
    const f = fusionarTramos(tramoA(), tramoB(), OPTS);
    const sello = selloEscalaQuitada(f, '  No bajamos en Holbox  ', OPTS.ahora);
    expect(
      sello.startsWith(
        '[Escala HOL quitada 2026-11-02T20:15:00.000Z] No bajamos en Holbox — CUN→HOL + HOL→TQO ⇒ CUN→TQO;',
      ),
    ).toBe(true);
    expect(textoAvisoEscalaQuitada(f, 'No bajamos en Holbox')).toBe(
      'Se quitó la escala en HOL: el tramo ahora es CUN → TQO. Motivo: No bajamos en Holbox. Oficina revisará el tacómetro del tramo fusionado.',
    );
  });
});
