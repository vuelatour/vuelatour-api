import { resolverAeronaveDeRevision } from './aeronave-revision.util';

/**
 * Bug cotización #254 (11-sep-2026): cambiar el avión en el cotizador no se
 * persistía (`vuelo.aeronave_id` seguía en el avión original), así que el
 * formulario volvía a abrir con el viejo y cada versión repetía el mismo
 * diff «Avión PIPER SENECA V→…». Aquí se fija el contrato de la fuente
 * única, incluido el caso #80 que motivó la regla anterior.
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
