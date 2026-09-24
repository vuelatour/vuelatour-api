import {
  avisoAvionSoloComercial,
  avisoFechaConservada,
  avisoFechaTramoVoladoConservada,
  estadoVueloVolado,
  fechaCambia,
  idAeronaveCotizada,
  resolverAeronaveDeRevision,
  resolverFechasDeRevision,
  tramoConservaFechaPlan,
} from './aeronave-revision.util';

/**
 * Bug cotización #254 (11-sep-2026): cambiar el avión en el cotizador no se
 * persistía (`vuelo.aeronave_id` seguía en el avión original), así que el
 * formulario volvía a abrir con el viejo y cada versión repetía el mismo
 * diff «Avión PIPER SENECA V→…». Aquí se fija el contrato de la fuente
 * única, incluido el caso #80 que motivó la regla anterior.
 *
 * Cotización #298 (12-sep-2026): «se cotiza con un avión y se vuela con otro
 * […] la cotización no debe verse afectada por cambios en el vuelo
 * operativo». El "cambió el avión" se mide contra el COTIZADO (snapshot), no
 * contra el operativo.
 */
const SENECA = 'a-seneca';
const C206 = 'a-cessna-206';
const N990 = 'a-n990gg';

describe('resolverAeronaveDeRevision', () => {
  it('el cotizador CAMBIA el avión → manda el del DTO (aunque el tramo 1 tenga otro)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: C206,
        aeronaveVuelo: SENECA,
        aeronavePrimerTramoActivo: SENECA,
      }),
    ).toEqual({
      aeronave_id: C206,
      cambio_deliberado: true,
      aeronave_anterior: SENECA,
      cambio_solo_comercial: false,
    });
  });

  it('revisión SIN cambio de avión → manda el OPERATIVO del primer tramo vivo (caso #80)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: N990,
        aeronaveVuelo: N990,
        aeronavePrimerTramoActivo: N990,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('quickAdjust (conservarOperativo): el avión del SNAPSHOT del DTO nunca reasigna el vuelo — caso #80', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: SENECA, // el snapshot: con el que se pactó el precio
        aeronaveVuelo: N990, // lo que opera hoy
        aeronavePrimerTramoActivo: N990,
        conservarOperativo: true,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('sin tramos vivos (o todos heredan): sin cambio, cae al avión del DTO', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: SENECA,
        aeronaveVuelo: SENECA,
        aeronavePrimerTramoActivo: null,
      }).aeronave_id,
    ).toBe(SENECA);
  });

  it('vuelo sin avión (reserva) + avión en el DTO = alta deliberada', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: C206,
        aeronaveVuelo: null,
        aeronavePrimerTramoActivo: null,
      }),
    ).toEqual({
      aeronave_id: C206,
      cambio_deliberado: true,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('externo (DTO sin avión propio): nunca hay cambio deliberado y no inventa avión', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: null,
        aeronaveVuelo: null,
        aeronavePrimerTramoActivo: null,
      }),
    ).toEqual({
      aeronave_id: null,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  // --- La cotización es independiente de la operación (#298, 12-sep-2026) ---

  it('#298: operativo ≠ cotizado y el DTO manda el COTIZADO ⇒ NO es deliberado y el vuelo conserva el OPERATIVO', () => {
    // Snapshot en Cessna 205, el vuelo se reasignó a N990GG (reassign): el
    // panel rehidrata el COTIZADO y guarda una versión sin tocar el selector.
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: C206,
        aeronaveVuelo: N990,
        aeronaveCotizada: C206,
        aeronavePrimerTramoActivo: N990,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('#298 sin tramos vivos: el vuelo conserva su avión OPERATIVO (nunca cae al del DTO)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: C206,
        aeronaveVuelo: N990,
        aeronaveCotizada: C206,
        aeronavePrimerTramoActivo: null,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('#298: el operador elige un TERCER avión ⇒ deliberado y el anterior es el OPERATIVO (para el blanket)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: SENECA,
        aeronaveVuelo: N990,
        aeronaveCotizada: C206,
        aeronavePrimerTramoActivo: N990,
      }),
    ).toEqual({
      aeronave_id: SENECA,
      cambio_deliberado: true,
      aeronave_anterior: N990,
      cambio_solo_comercial: false,
    });
  });

  it('#298 + conservarOperativo (quickAdjust/grupo): jamás reasigna aunque el DTO traiga otro avión', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: SENECA,
        aeronaveVuelo: N990,
        aeronaveCotizada: C206,
        aeronavePrimerTramoActivo: N990,
        conservarOperativo: true,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('el DTO re-envía el avión que YA opera el vuelo: no hay nada que asignar (sin pre-check ni blanket)', () => {
    // Panel viejo (rehidrataba desde vuelo.aeronave_id): no debe volverse
    // "cambio deliberado" solo porque el cotizado sea otro.
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: N990,
        aeronaveVuelo: N990,
        aeronaveCotizada: C206,
        aeronavePrimerTramoActivo: N990,
      }),
    ).toEqual({
      aeronave_id: N990,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('sin snapshot (reserva sin cotizar) la referencia sigue siendo el operativo', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: C206,
        aeronaveVuelo: SENECA,
        aeronaveCotizada: null,
        aeronavePrimerTramoActivo: SENECA,
      }),
    ).toEqual({
      aeronave_id: C206,
      cambio_deliberado: true,
      aeronave_anterior: SENECA,
      cambio_solo_comercial: false,
    });
  });

  it('cadenas vacías se tratan como ausencia (no cuentan como cambio)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: '   ',
        aeronaveVuelo: SENECA,
        aeronavePrimerTramoActivo: SENECA,
      }),
    ).toEqual({
      aeronave_id: SENECA,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });
});

describe('idAeronaveCotizada (avión del SNAPSHOT vigente)', () => {
  it('devuelve el id del snapshot; sin snapshot o sin avión, null', () => {
    expect(
      idAeronaveCotizada({ aeronave: { id: C206, modelo: 'Cessna 205' } }),
    ).toBe(C206);
    expect(idAeronaveCotizada(null)).toBeNull();
    expect(idAeronaveCotizada({})).toBeNull();
    expect(idAeronaveCotizada({ aeronave: { id: '  ' } })).toBeNull();
  });

  it('externo: SÍ devuelve la referencia de tarifa (a diferencia del modelo, que el cliente no ve)', () => {
    expect(
      idAeronaveCotizada({ aeronave: { id: SENECA, modelo: 'Seneca V' } }),
    ).toBe(SENECA);
  });
});

/**
 * COTIZACIÓN #338 (24-sep-2026, Mike Nelson, CUN→PTU→CUN): se cotizó y voló
 * en el Seneca N4142R (dos tramos con tacos, COMPLETADO). Ya aterrizado, la
 * oficina guardó la v2 «se cobra como Cessna, pidieron Cessna» con el Cessna
 * 206 XA-VGV en el selector. La revisión lo leyó como CAMBIO DELIBERADO:
 * la cabecera pasó a XA-VGV (tramos en N4142R) y piloto y copiloto
 * recibieron «Ahora vuela en XA-VGV». Con el vuelo volado el avión del
 * cotizador es SOLO COMERCIAL.
 */
describe('resolverAeronaveDeRevision — vuelo que YA VOLÓ (#338)', () => {
  const N4142R = 'a-n4142r'; // PIPER SENECA V: el que VOLÓ
  const XAVGV = 'a-xa-vgv'; // Cessna 206: con el que ahora se COBRA

  it('#338 exacto: cotizado y volado en N4142R, el cotizador elige XA-VGV ⇒ el vuelo SIGUE en N4142R y el cambio es solo comercial', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: N4142R,
        aeronaveCotizada: N4142R,
        aeronavePrimerTramoActivo: N4142R,
        yaVolo: true,
      }),
    ).toEqual({
      aeronave_id: N4142R,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: true,
    });
  });

  it('#338 ya dañado (cabecera XA-VGV, tramos N4142R): conserva el avión del TRAMO con el que voló (repara la cabecera)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: XAVGV,
        aeronaveCotizada: XAVGV,
        aeronavePrimerTramoActivo: N4142R,
        yaVolo: true,
      }),
    ).toEqual({
      aeronave_id: N4142R,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('volado y los tramos heredan (null): respaldo la cabecera, JAMÁS el avión del DTO', () => {
    const r = resolverAeronaveDeRevision({
      aeronaveDto: XAVGV,
      aeronaveVuelo: N4142R,
      aeronaveCotizada: N4142R,
      aeronavePrimerTramoActivo: null,
      yaVolo: true,
    });
    expect(r.aeronave_id).toBe(N4142R);
    expect(r.cambio_deliberado).toBe(false);
    expect(r.cambio_solo_comercial).toBe(true);
  });

  it('volado sin avión alguno: no inventa uno con el del DTO (null)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: null,
        aeronavePrimerTramoActivo: null,
        yaVolo: true,
      }).aeronave_id,
    ).toBeNull();
  });

  it('volado + el cotizador re-envía el MISMO cotizado: sin aviso de cambio', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: N4142R,
        aeronaveCotizada: XAVGV,
        aeronavePrimerTramoActivo: N4142R,
        yaVolo: true,
      }),
    ).toEqual({
      aeronave_id: N4142R,
      cambio_deliberado: false,
      aeronave_anterior: null,
      cambio_solo_comercial: false,
    });
  });

  it('volado + el cotizador regresa al avión con el que voló: sigue siendo solo comercial (el precio vuelve al Seneca)', () => {
    const r = resolverAeronaveDeRevision({
      aeronaveDto: N4142R,
      aeronaveVuelo: N4142R,
      aeronaveCotizada: XAVGV,
      aeronavePrimerTramoActivo: N4142R,
      yaVolo: true,
    });
    expect(r.aeronave_id).toBe(N4142R);
    expect(r.cambio_solo_comercial).toBe(true);
  });

  it('volado + conservarOperativo (quickAdjust/grupo): nunca avisa de cambio comercial', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: N4142R,
        aeronaveCotizada: N4142R,
        aeronavePrimerTramoActivo: N4142R,
        conservarOperativo: true,
        yaVolo: true,
      }).cambio_solo_comercial,
    ).toBe(false);
  });

  it('SIN volar, el mismo cambio SÍ es deliberado (contrato del 11-sep intacto)', () => {
    expect(
      resolverAeronaveDeRevision({
        aeronaveDto: XAVGV,
        aeronaveVuelo: N4142R,
        aeronaveCotizada: N4142R,
        aeronavePrimerTramoActivo: N4142R,
        yaVolo: false,
      }),
    ).toEqual({
      aeronave_id: XAVGV,
      cambio_deliberado: true,
      aeronave_anterior: N4142R,
      cambio_solo_comercial: false,
    });
  });
});

describe('estadoVueloVolado (fuente única de «ya voló»)', () => {
  const t = (orden: number, taco: number | null, extra = {}) => ({
    orden,
    taco_salida: taco,
    taco_llegada: taco == null ? null : taco + 1.2,
    cancelada_at: null,
    ...extra,
  });

  it('#338: COMPLETADO con los dos tramos con taco ⇒ ya voló y terminó', () => {
    expect(
      estadoVueloVolado('COMPLETADO', [t(1, 4460.5), t(2, 4461.7)]),
    ).toEqual({ ya_volo: true, termino: true });
  });

  it('COMPLETADO sin tacos (externo / cerrado a mano) ⇒ ya voló y terminó', () => {
    expect(estadoVueloVolado('COMPLETADO', [t(1, null)])).toEqual({
      ya_volo: true,
      termino: true,
    });
  });

  it('EN_VUELO de varios días con el regreso pendiente ⇒ ya voló pero NO terminó', () => {
    expect(estadoVueloVolado('EN_VUELO', [t(1, 100), t(2, null)])).toEqual({
      ya_volo: true,
      termino: false,
    });
  });

  it('CONFIRMADO con un tramo con taco (estado aún no derivado) ⇒ ya voló', () => {
    expect(
      estadoVueloVolado('CONFIRMADO', [t(1, 100), t(2, null)]).ya_volo,
    ).toBe(true);
  });

  it('el ÚLTIMO tramo vivo con taco ⇒ terminó (sin importar el orden del arreglo)', () => {
    expect(estadoVueloVolado('EN_VUELO', [t(2, 200), t(1, 100)]).termino).toBe(
      true,
    );
  });

  it('un tramo CANCELADO con taco no cuenta', () => {
    expect(
      estadoVueloVolado('CONFIRMADO', [
        t(1, 100, { cancelada_at: '2026-09-20T00:00:00Z' }),
        t(2, null),
      ]),
    ).toEqual({ ya_volo: false, termino: false });
  });

  it('cotización sin volar (COTIZADO/CANCELADO sin tacos, sin tramos) ⇒ nada', () => {
    expect(estadoVueloVolado('COTIZADO', [t(1, null)])).toEqual({
      ya_volo: false,
      termino: false,
    });
    expect(estadoVueloVolado('CANCELADO', [])).toEqual({
      ya_volo: false,
      termino: false,
    });
    expect(estadoVueloVolado(null, null)).toEqual({
      ya_volo: false,
      termino: false,
    });
  });

  it('un taco en 0 también es captura (no se confunde con vacío)', () => {
    expect(estadoVueloVolado('CONFIRMADO', [t(1, 0)]).ya_volo).toBe(true);
  });
});

describe('resolverFechasDeRevision (qué fechas del vuelo escribe una revisión)', () => {
  const SALIDA = '2026-09-24T13:30:00+00:00';
  const nuevo = new Date('2026-09-24T15:00:00.000Z');

  it('#338: COMPLETADO y el DTO trae un regreso nuevo (—→ 10:00) ⇒ NO se escribe y se avisa', () => {
    const r = resolverFechasDeRevision({
      salidaDto: new Date(SALIDA),
      regresoDto: nuevo,
      salidaActual: SALIDA,
      regresoActual: null,
      volado: { ya_volo: true, termino: true },
    });
    expect(r.salida).toBeUndefined();
    expect(r.regreso).toBeUndefined();
    expect(r.salida_cambio).toBe(false);
    expect(r.regreso_cambio).toBe(false);
    // La salida venía IGUAL: nada que avisar; el regreso sí difería.
    expect(r.salida_conservada).toBe(false);
    expect(r.regreso_conservada).toBe(true);
  });

  it('sin volar: se escribe lo que viaja y la reagenda se marca solo si cambia', () => {
    const r = resolverFechasDeRevision({
      salidaDto: new Date(SALIDA),
      regresoDto: nuevo,
      salidaActual: SALIDA,
      regresoActual: null,
      volado: { ya_volo: false, termino: false },
    });
    expect(r.salida?.toISOString()).toBe(new Date(SALIDA).toISOString());
    expect(r.regreso).toBe(nuevo);
    expect(r.salida_cambio).toBe(false);
    expect(r.regreso_cambio).toBe(true);
    expect(r.salida_conservada || r.regreso_conservada).toBe(false);
  });

  it('EN_VUELO de varios días: la salida se conserva pero el REGRESO (aún no vuela) sí se reagenda', () => {
    const r = resolverFechasDeRevision({
      salidaDto: nuevo,
      regresoDto: new Date('2026-09-27T20:00:00.000Z'),
      salidaActual: SALIDA,
      regresoActual: '2026-09-26T20:00:00+00:00',
      volado: { ya_volo: true, termino: false },
    });
    expect(r.salida).toBeUndefined();
    expect(r.salida_conservada).toBe(true);
    expect(r.regreso?.toISOString()).toBe('2026-09-27T20:00:00.000Z');
    expect(r.regreso_cambio).toBe(true);
  });

  it('el DTO sin fechas no escribe ni avisa nada', () => {
    expect(
      resolverFechasDeRevision({
        salidaActual: SALIDA,
        regresoActual: null,
        volado: { ya_volo: true, termino: true },
      }),
    ).toEqual({
      salida: undefined,
      regreso: undefined,
      salida_cambio: false,
      regreso_cambio: false,
      salida_conservada: false,
      regreso_conservada: false,
    });
  });

  it('fechaCambia compara por INSTANTE (el string de PostgREST vs el ISO del DTO)', () => {
    expect(fechaCambia(new Date(SALIDA), '2026-09-24T13:30:00.000Z')).toBe(
      false,
    );
    expect(fechaCambia(new Date(SALIDA), null)).toBe(true);
    expect(fechaCambia(undefined, SALIDA)).toBe(false);
  });
});

describe('textos de los avisos (revise.avisos[])', () => {
  it('#338: el texto exacto del cambio de avión solo comercial', () => {
    expect(avisoAvionSoloComercial(['N4142R'], 'Cessna 206')).toBe(
      'El vuelo ya voló en N4142R: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.',
    );
  });

  it('multi-avión y sin datos: el texto sigue siendo legible', () => {
    expect(avisoAvionSoloComercial(['N4142R', 'XB-ANU'], 'Cessna 206')).toBe(
      'El vuelo ya voló en N4142R y XB-ANU: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.',
    );
    expect(avisoAvionSoloComercial([], null)).toBe(
      'El vuelo ya voló: el cambio de avión solo cambia con qué se cobra; la operación no se modifica.',
    );
  });

  it('fecha conservada: dice cuál se queda (hora Cancún) o que no hay regreso', () => {
    expect(avisoFechaConservada('salida', '2026-09-24T13:30:00+00:00')).toMatch(
      /^El vuelo ya voló: la fecha de salida no se cambia desde la cotización .*24\/09\/26.*8:30.*\(hora Cancún\)\.$/,
    );
    expect(avisoFechaConservada('regreso', null)).toBe(
      'El viaje ya terminó: la fecha de regreso no se cambia desde la cotización (movería el calendario); el vuelo se queda sin fecha de regreso.',
    );
  });
});

describe('tramoConservaFechaPlan (fecha planeada de un tramo que ya voló, #338)', () => {
  it('tramo con tacómetro y fecha planeada ⇒ la cotización no la mueve', () => {
    expect(
      tramoConservaFechaPlan({
        taco_salida: 4461.7,
        taco_llegada: 4462.9,
        fecha_salida_plan: '2026-09-24T15:00:00+00:00',
      }),
    ).toBe(true);
    // Solo la salida capturada (a medio tramo) también cuenta; un 0 es captura.
    expect(
      tramoConservaFechaPlan({
        taco_salida: 0,
        taco_llegada: null,
        fecha_salida_plan: '2026-09-24T15:00:00+00:00',
      }),
    ).toBe(true);
  });

  it('tramo sin volar, o volado SIN fecha (legado) ⇒ se escribe como siempre', () => {
    expect(
      tramoConservaFechaPlan({
        taco_salida: null,
        taco_llegada: null,
        fecha_salida_plan: '2026-09-24T15:00:00+00:00',
      }),
    ).toBe(false);
    expect(
      tramoConservaFechaPlan({
        taco_salida: 1,
        taco_llegada: 2,
        fecha_salida_plan: null,
      }),
    ).toBe(false);
  });

  it('aviso: tramo, ruta y la fecha que se conserva (hora Cancún)', () => {
    expect(
      avisoFechaTramoVoladoConservada(
        2,
        'PTU → CUN',
        '2026-09-24T15:00:00+00:00',
      ),
    ).toMatch(
      /^El tramo 2 \(PTU → CUN\) ya voló: su fecha de salida no se cambia desde la cotización \(movería el calendario\); se conserva la del vuelo: 24\/09\/26.*10:00.*\(hora Cancún\)\.$/,
    );
    expect(avisoFechaTramoVoladoConservada(1, 'CUN → PTU', null)).toBe(
      'El tramo 1 (CUN → PTU) ya voló: su fecha de salida no se cambia desde la cotización (movería el calendario).',
    );
  });
});
