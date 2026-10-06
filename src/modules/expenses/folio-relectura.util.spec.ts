import {
  FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT,
  FOLIOS_RELEER_DESDE_DEFAULT,
  FOLIOS_RELEER_LOTE_DEFAULT,
  FOLIOS_RELEER_LOTE_MAX,
  clasificarMotivoLectura,
  corteCapturadosHasta,
  esArchivoAusente,
  evaluarLecturaFolio,
  fotosAdicionalesDe,
  lecturaConFolio,
  lineaFolioDuplicado,
  loteRelectura,
  notasConLinea,
  ordenarCandidatos,
  tipoDocumento,
} from './folio-relectura.util';

/** Decisiones PURAS del cron `gastos-releer-folio` (invariante 46). */
describe('folio-relectura.util', () => {
  it('defaults del pedido', () => {
    expect(FOLIOS_RELEER_LOTE_DEFAULT).toBe(15);
    expect(FOLIOS_RELEER_DESDE_DEFAULT).toBe('2026-09-01');
    expect(FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT).toBe('2026-10-05');
  });

  it('loteRelectura: entero 1–50; lo demás ⇒ default', () => {
    expect(loteRelectura(15)).toBe(15);
    expect(loteRelectura(7.9)).toBe(7);
    expect(loteRelectura(500)).toBe(FOLIOS_RELEER_LOTE_MAX);
    expect(loteRelectura(0)).toBe(15);
    expect(loteRelectura(-3)).toBe(15);
    expect(loteRelectura('abc')).toBe(15);
    expect(loteRelectura(null)).toBe(15);
  });

  it('corteCapturadosHasta: día siguiente a las 00:00 Cancún (lt)', () => {
    expect(corteCapturadosHasta('2026-10-05')).toBe(
      '2026-10-06T00:00:00-05:00',
    );
    expect(corteCapturadosHasta('2026-10-31')).toBe(
      '2026-11-01T00:00:00-05:00',
    );
    expect(corteCapturadosHasta('2026-12-31')).toBe(
      '2027-01-01T00:00:00-05:00',
    );
  });

  it('ordenarCandidatos: postergados al final (del más viejo al más nuevo) y corta al lote', () => {
    const f = (id: string) => ({ id });
    const filas = [f('a'), f('b'), f('c'), f('d')];
    expect(ordenarCandidatos(filas, [], 3).map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ordenarCandidatos(filas, ['b', 'a'], 4).map((x) => x.id)).toEqual([
      'c',
      'd',
      'b',
      'a',
    ]);
    expect(ordenarCandidatos(filas, ['zz'], 2).map((x) => x.id)).toEqual([
      'a',
      'b',
    ]);
    expect(ordenarCandidatos(filas, [], 0)).toEqual([]);
  });

  it('fotosAdicionalesDe y tipoDocumento', () => {
    expect(
      fotosAdicionalesDe({ fotos_adicionales: ['x/2.jpg', '', 3, 'x/3.jpg'] }),
    ).toEqual(['x/2.jpg', 'x/3.jpg']);
    expect(fotosAdicionalesDe(null)).toEqual([]);
    expect(fotosAdicionalesDe(['x'])).toEqual([]);
    expect(tipoDocumento('u/f.PDF')).toBe('PDF');
    expect(tipoDocumento('u/f.xlsx')).toBe('EXCEL');
    expect(tipoDocumento('u/f.csv')).toBe('EXCEL');
    expect(tipoDocumento('u/f.jpg')).toBeNull();
  });

  it.each([
    [
      'Sin saldo de créditos de IA en Anthropic: hay que recargar (Plans & Billing) y registrar el nuevo saldo en Configuración → Consumo de IA',
      'IA_NO_DISPONIBLE',
    ],
    [
      'Se alcanzó el límite de gasto de IA configurado en Anthropic: avisa a sistemas para que lo suban',
      'IA_NO_DISPONIBLE',
    ],
    [
      'La llave de la IA no es válida o venció: avisa a sistemas',
      'IA_NO_DISPONIBLE',
    ],
    [
      'El modelo de IA configurado no existe: avisa a sistemas (se elige en Configuración → Créditos de IA)',
      'IA_NO_DISPONIBLE',
    ],
    ['INTERNAL_SHARED_TOKEN no configurado', 'IA_NO_DISPONIBLE'],
    ['Token interno inválido', 'IA_NO_DISPONIBLE'],
    [
      'Claude no disponible (400): Your credit balance is too low to access the Anthropic API',
      'IA_NO_DISPONIBLE',
    ],
    [
      'La foto o el archivo pesa demasiado para la IA (máx. 5 MB por foto, 32 MB por PDF): toma otra foto o recórtala',
      'COMPROBANTE',
    ],
    [
      'La foto es demasiado grande en pixeles para la IA: tómala con menor resolución o recórtala',
      'COMPROBANTE',
    ],
    [
      'Formato de archivo no soportado por la IA: usa una foto JPG o PNG, o un PDF',
      'COMPROBANTE',
    ],
    [
      'La IA no pudo leer la foto: toma otra con mejor luz y enfoque',
      'COMPROBANTE',
    ],
    [
      'El documento es demasiado largo para la IA: pártelo en varios archivos',
      'COMPROBANTE',
    ],
    [
      'Demasiadas fotos en una sola lectura: léelas en dos tandas',
      'COMPROBANTE',
    ],
    [
      'La foto llegó marcada con un formato distinto al real: reintenta y, si se repite, avisa a sistemas',
      'TRANSITORIO',
    ],
    [
      'La IA está saturada o caída por el momento: reintenta en unos minutos',
      'TRANSITORIO',
    ],
    ['Claude no disponible (400): Unable to download the file', 'TRANSITORIO'],
    ['Sin conexión con pyservices: fetch failed', 'TRANSITORIO'],
    ['La lectura tardó demasiado (timeout API→pyservices)', 'TRANSITORIO'],
    ['pyservices 503', 'TRANSITORIO'],
    ['algo nuevo que no conocemos', 'TRANSITORIO'],
    ['', 'TRANSITORIO'],
  ])('clasificarMotivoLectura(%p) ⇒ %s', (motivo, esperado) => {
    expect(clasificarMotivoLectura(motivo)).toBe(esperado);
  });

  it('evaluarLecturaFolio', () => {
    expect(evaluarLecturaFolio(null)).toMatchObject({
      tipo: 'FALLO',
      fallo: 'IA_NO_DISPONIBLE',
    });
    expect(evaluarLecturaFolio({ motivo: 'pyservices 500' })).toEqual({
      tipo: 'FALLO',
      fallo: 'TRANSITORIO',
      motivo: 'pyservices 500',
    });
    expect(
      evaluarLecturaFolio({
        motivo: 'La IA no pudo leer la foto: toma otra con mejor luz y enfoque',
      }),
    ).toEqual({
      tipo: 'ILEGIBLE',
      motivo: 'La IA no pudo leer la foto: toma otra con mejor luz y enfoque',
    });
    expect(
      evaluarLecturaFolio({ legible: false, monto: null, folio: 'A-1' }),
    ).toEqual({ tipo: 'ILEGIBLE', motivo: null });
    expect(
      evaluarLecturaFolio({ legible: true, monto: 10, folio: ' A-1 ' }),
    ).toEqual({ tipo: 'FOLIO', folio: 'A-1' });
    expect(
      evaluarLecturaFolio({ legible: true, monto: 10, folio: null }),
    ).toEqual({ tipo: 'SIN_FOLIO' });
    expect(
      evaluarLecturaFolio({ legible: true, monto: 10, folio: 'S/N' }),
    ).toEqual({ tipo: 'SIN_FOLIO' });
  });

  it('lecturaConFolio: rellena la llave en la PREVIA; sin previa, la nueva sin `motivo`', () => {
    const previa = {
      legible: true,
      folio: null,
      fotos_adicionales: ['x/2.jpg'],
      proveedor: 'ASUR',
    };
    expect(
      lecturaConFolio(previa, { proveedor: 'OTRO', folio: 'A-1' }, 'A-1'),
    ).toEqual({ ...previa, folio: 'A-1' });
    expect(
      lecturaConFolio(
        null,
        { proveedor: 'OTRO', motivo: 'x', folio: ' A-1 ' },
        'A-1',
      ),
    ).toEqual({
      proveedor: 'OTRO',
      folio: 'A-1',
    });
    expect(lecturaConFolio(['raro'], { legible: true }, 'B-2')).toEqual({
      legible: true,
      folio: 'B-2',
    });
  });

  it('notas del duplicado: línea ⚠ al final, sin repetirla', () => {
    const l = lineaFolioDuplicado('FEACZM-72128');
    expect(l).toBe(
      '⚠ IA: folio FEACZM-72128 ya existe en otro gasto — revisar',
    );
    expect(notasConLinea(null, l)).toBe(l);
    expect(notasConLinea('Pago ASUR\n\n', l)).toBe(`Pago ASUR\n${l}`);
    expect(notasConLinea(`Pago ASUR\n${l}`, l)).toBe(`Pago ASUR\n${l}`);
  });

  it('esArchivoAusente: «no existe» de Storage vs error de red', () => {
    expect(esArchivoAusente('Object not found')).toBe(true);
    expect(
      esArchivoAusente(
        'Either the object does not exist or you do not have access to it',
      ),
    ).toBe(true);
    expect(esArchivoAusente('fetch failed')).toBe(false);
    expect(esArchivoAusente(null)).toBe(false);
  });
});
