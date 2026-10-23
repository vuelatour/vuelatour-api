import {
  ALIAS_REGEX,
  CLIENTE_VUELO_SERVICIO,
  MENSAJE_ALIAS_INVALIDO,
  claveCliente,
  claveDinero,
  claveLibro,
  claveOtrosMovimientos,
  consecutivoClienteValido,
  ddmmaaCancun,
  normalizarAliasEntrada,
  parseBusquedaClave,
} from './clave-cliente.util';

/**
 * ID DE VUELO POR CLIENTE (13-oct-2026, invariante 68): fuente única PURA del
 * texto «diego01-131026». Casos reales de prod: #364 ⇒ beh05-011026, #376 ⇒
 * january02-211026, #166 (sin fecha) ⇒ francisco10.
 */

describe('ALIAS_REGEX (mismo literal que el CHECK cliente_alias_chk y el panel)', () => {
  it('acepta 1 a 24 letras minúsculas a-z', () => {
    for (const ok of ['diego', 'a', 'abcdefghijklmnopqrstuvwx']) {
      expect(ALIAS_REGEX.test(ok)).toBe(true);
    }
  });

  it('rechaza mayúsculas, números, ñ/acentos, signos, vacío y 25 letras', () => {
    for (const mal of [
      'Diego',
      'diego2',
      'ñandu',
      'jb-x',
      '',
      'abcdefghijklmnopqrstuvwxy',
    ]) {
      expect(ALIAS_REGEX.test(mal)).toBe(false);
    }
    expect(ALIAS_REGEX.source).toBe('^[a-z]{1,24}$');
  });

  it('el mensaje del 400 es el del contrato (el panel lo compara)', () => {
    expect(MENSAJE_ALIAS_INVALIDO).toBe(
      'Alias inválido: usa de 1 a 24 letras minúsculas, sin acentos, espacios, números ni signos (ej. diego).',
    );
  });
});

describe('normalizarAliasEntrada (@Transform del DTO)', () => {
  it('recorta y pasa a minúsculas; vacío ⇒ null (= volver al sugerido)', () => {
    expect(normalizarAliasEntrada(' DIEGO ')).toBe('diego');
    expect(normalizarAliasEntrada('')).toBeNull();
    expect(normalizarAliasEntrada('  ')).toBeNull();
    expect(normalizarAliasEntrada(null)).toBeNull();
  });

  it('otro tipo pasa TAL CUAL (lo rechaza @IsString)', () => {
    expect(normalizarAliasEntrada(5)).toBe(5);
    expect(normalizarAliasEntrada(undefined)).toBeUndefined();
  });
});

describe('ddmmaaCancun (día Cancún, nunca lanza)', () => {
  it('instante ⇒ DDMMAA del día Cancún, no del UTC', () => {
    expect(ddmmaaCancun('2026-10-01T15:00:00+00:00')).toBe('011026');
    // 03:30Z del 14 = 22:30 del 13 en Cancún.
    expect(ddmmaaCancun('2026-10-14T03:30:00Z')).toBe('131026');
  });

  it("'YYYY-MM-DD' es fecha de pared", () => {
    expect(ddmmaaCancun('2026-10-13')).toBe('131026');
  });

  it('null, vacío, basura o fecha imposible ⇒ null sin lanzar', () => {
    expect(ddmmaaCancun(null)).toBeNull();
    expect(ddmmaaCancun(undefined)).toBeNull();
    expect(ddmmaaCancun('')).toBeNull();
    expect(ddmmaaCancun('no-es-fecha')).toBeNull();
    expect(ddmmaaCancun('2026-02-31')).toBeNull();
  });
});

describe('claveCliente (EL ID; nunca inventa)', () => {
  it('casos reales: #364, #376, número de 3 dígitos, número como string y sin fecha', () => {
    expect(
      claveCliente({
        alias: 'beh',
        consecutivo: 5,
        fecha_vuelo: '2026-10-01T15:00:00+00:00',
      }),
    ).toBe('beh05-011026');
    expect(
      claveCliente({
        alias: 'january',
        consecutivo: 2,
        fecha_vuelo: '2026-10-21T14:00:00Z',
      }),
    ).toBe('january02-211026');
    expect(
      claveCliente({
        alias: 'diego',
        consecutivo: 100,
        fecha_vuelo: '2026-10-13',
      }),
    ).toBe('diego100-131026');
    expect(
      claveCliente({
        alias: 'diego',
        consecutivo: '7',
        fecha_vuelo: '2026-10-13',
      }),
    ).toBe('diego07-131026');
    expect(
      claveCliente({ alias: 'francisco', consecutivo: 10, fecha_vuelo: null }),
    ).toBe('francisco10');
  });

  it('día Cancún: 03:30Z del 14 ⇒ diego01-131026', () => {
    expect(
      claveCliente({
        alias: 'diego',
        consecutivo: 1,
        fecha_vuelo: '2026-10-14T03:30:00Z',
      }),
    ).toBe('diego01-131026');
  });

  it('fecha que no es string o inválida ⇒ sin sufijo (no se inventa)', () => {
    expect(
      claveCliente({ alias: 'diego', consecutivo: 1, fecha_vuelo: 20261013 }),
    ).toBe('diego01');
    expect(
      claveCliente({ alias: 'diego', consecutivo: 1, fecha_vuelo: 'x' }),
    ).toBe('diego01');
  });

  it.each([null, undefined, '', 'Diego', 'diego2', 5])(
    'alias %p ⇒ null',
    (alias) => {
      expect(
        claveCliente({ alias, consecutivo: 1, fecha_vuelo: '2026-10-13' }),
      ).toBeNull();
    },
  );

  it.each([0, null, undefined, 1.5, '3x', -2, '', '0'])(
    'consecutivo %p ⇒ null',
    (consecutivo) => {
      expect(
        claveCliente({
          alias: 'diego',
          consecutivo,
          fecha_vuelo: '2026-10-13',
        }),
      ).toBeNull();
    },
  );
});

describe('parseBusquedaClave (búsqueda por ID; la fecha escrita se ignora)', () => {
  it('forma de ID ⇒ { alias en minúsculas, consecutivo }', () => {
    expect(parseBusquedaClave('diego02')).toEqual({
      alias: 'diego',
      consecutivo: 2,
    });
    expect(parseBusquedaClave('DIEGO02-211026')).toEqual({
      alias: 'diego',
      consecutivo: 2,
    });
    expect(parseBusquedaClave(' january2 ')).toEqual({
      alias: 'january',
      consecutivo: 2,
    });
  });

  it.each([
    'diego00',
    '376',
    'maqar',
    'holbox',
    'CUN',
    'Mérida, (MX)',
    'n4142r',
    'xa-vgv',
    'a-0411',
    '',
    'diego02-2110',
    'diego12345',
  ])('%p no tiene forma de ID ⇒ null', (q) => {
    expect(parseBusquedaClave(q)).toBeNull();
  });

  it('null / undefined ⇒ null', () => {
    expect(parseBusquedaClave(null)).toBeNull();
    expect(parseBusquedaClave(undefined)).toBeNull();
  });
});

/**
 * CLAVES SIN APODO EN LOS DOCUMENTOS (23-oct-2026, API 0.0.105, invariante
 * 106): «siempre debemos ocultar los apodos con la clave del vuelo … mejor
 * eliminar esos apodos de todos lados». Las tres claves de los documentos
 * son SOLO el folio; el ID («beh05-011026»), el legado («vtbeh364», «vtbeh»)
 * y «vtservicio» ya no se imprimen. Los parámetros viejos se aceptan y se
 * ignoran (ninguna llamada se rompe).
 */
const FORMA_ID = /[a-z]+[0-9]{2,}-[0-9]{6}/;

describe('claveLibro (maestra y cobranza): «#folio» y nada más', () => {
  it('con ID y con cliente sigue siendo SOLO el folio (el cliente viaja en su columna)', () => {
    expect(
      claveLibro({
        folio: 364,
        claveCliente: 'beh05-011026',
        cliente: 'Beh Kay ',
      }),
    ).toBe('#364');
    expect(
      claveLibro({ folio: 364, claveCliente: 'beh05-011026', cliente: null }),
    ).toBe('#364');
  });

  it.each(['Beh Kay ', 'Maqar', '', null])(
    'sin ID y con cliente %p: «#364» (ya no «#364 · cliente»)',
    (cliente) => {
      expect(claveLibro({ folio: '364', claveCliente: null, cliente })).toBe(
        '#364',
      );
    },
  );

  it('solo con el folio (la llamada nueva) y nunca con forma de ID', () => {
    expect(claveLibro({ folio: 219 })).toBe('#219');
    expect(
      FORMA_ID.test(claveLibro({ folio: 219, claveCliente: 'ana02-010926' })),
    ).toBe(false);
  });
});

describe('claveOtrosMovimientos y claveDinero: «#folio» y nada más', () => {
  it('otros movimientos: con ID, sin ID y sin legado ⇒ «#364»', () => {
    expect(
      claveOtrosMovimientos({
        folio: 364,
        claveCliente: 'beh05-011026',
        legado: 'vtbeh364',
      }),
    ).toBe('#364');
    expect(
      claveOtrosMovimientos({
        folio: 364,
        claveCliente: null,
        legado: 'vtbeh364',
      }),
    ).toBe('#364');
    expect(claveOtrosMovimientos({ folio: '364' })).toBe('#364');
  });

  it("dinero: también el vuelo de SERVICIO es «#folio» (ya no 'vtservicio'); con ID o legado, igual", () => {
    expect(
      claveDinero({
        folio: 504,
        servicio: true,
        claveCliente: 'beh05-011026',
        legado: 'vtbeh',
      }),
    ).toBe('#504');
    expect(
      claveDinero({
        folio: 364,
        servicio: false,
        claveCliente: 'beh05-011026',
        legado: 'vtbeh',
      }),
    ).toBe('#364');
    expect(
      claveDinero({
        folio: 364,
        servicio: false,
        claveCliente: null,
        legado: 'vtbeh',
      }),
    ).toBe('#364');
    expect(claveDinero({ folio: 364 })).toBe('#364');
  });

  it('la etiqueta del cliente de un vuelo de servicio es «Vuelo de servicio»', () => {
    expect(CLIENTE_VUELO_SERVICIO).toBe('Vuelo de servicio');
  });
});

describe('consecutivoClienteValido (la columna CONSECUTIVO de los documentos)', () => {
  it('entero ≥ 1 como number o como string de dígitos; otro ⇒ null', () => {
    expect(consecutivoClienteValido(5)).toBe(5);
    expect(consecutivoClienteValido('12')).toBe(12);
    for (const mal of [0, -1, 1.5, '0', '3x', '', null, undefined, true]) {
      expect(consecutivoClienteValido(mal)).toBeNull();
    }
  });
});
