import {
  idAeronaveCotizada,
  resolverAeronaveDeRevision,
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
