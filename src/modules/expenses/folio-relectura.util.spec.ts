import {
  FALLOS_CON_IA_PARA_SELLAR,
  FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT,
  FOLIOS_RELEER_DESDE_DEFAULT,
  FOLIOS_RELEER_LOTE_DEFAULT,
  FOLIOS_RELEER_LOTE_MAX,
  INTENTOS_MAX_POR_GASTO,
  REINTENTO_POSTERGADO_MS,
  archivosDelComprobante,
  clasificarMotivoLectura,
  corteCapturadosHasta,
  destinoTrasFallo,
  esArchivoAusente,
  evaluarLecturaFolio,
  falloSinCosto,
  fotosAdicionalesDe,
  lecturaConFolio,
  lineaFolioDuplicado,
  loteRelectura,
  mismoComprobante,
  notasConLinea,
  ordenarCandidatos,
  registrarFallo,
  tipoDocumento,
  type EstadoPostergado,
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

  it('ordenarCandidatos: postergados al final (del más viejo al más nuevo), ≥ 1 h, sin retirados y corta al lote', () => {
    const f = (id: string) => ({ id });
    const filas = [f('a'), f('b'), f('c'), f('d')];
    const H = REINTENTO_POSTERGADO_MS;
    const ahora = 10 * H;
    const p = (ultimoIntento: number, retirado = false) => ({
      ultimoIntento,
      retirado,
    });
    const vacio = new Map<string, ReturnType<typeof p>>();
    expect(ordenarCandidatos(filas, vacio, 3, ahora).map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const viejos = new Map([
      ['b', p(ahora - 3 * H)],
      ['a', p(ahora - 2 * H)],
    ]);
    expect(ordenarCandidatos(filas, viejos, 4, ahora).map((x) => x.id)).toEqual(
      ['c', 'd', 'b', 'a'],
    );
    // Orden por el último fallo, no por la inserción.
    const alReves = new Map([
      ['a', p(ahora - 2 * H)],
      ['b', p(ahora - 3 * H)],
    ]);
    expect(
      ordenarCandidatos(filas, alReves, 4, ahora).map((x) => x.id),
    ).toEqual(['c', 'd', 'b', 'a']);
    // Falló hace menos de 1 h ⇒ esta corrida NO lo toma; exactamente 1 h sí.
    const recientes = new Map([
      ['a', p(ahora - H + 1)],
      ['b', p(ahora - H)],
    ]);
    expect(
      ordenarCandidatos(filas, recientes, 4, ahora).map((x) => x.id),
    ).toEqual(['c', 'd', 'b']);
    // Retirado ⇒ fuera aunque haya pasado la hora.
    const retirado = new Map([['c', p(ahora - 5 * H, true)]]);
    expect(
      ordenarCandidatos(filas, retirado, 4, ahora).map((x) => x.id),
    ).toEqual(['a', 'b', 'd']);
    expect(
      ordenarCandidatos(filas, new Map([['zz', p(0)]]), 2, ahora).map(
        (x) => x.id,
      ),
    ).toEqual(['a', 'b']);
    expect(ordenarCandidatos(filas, vacio, 0, ahora)).toEqual([]);
  });

  describe('fallos por gasto: registrarFallo + destinoTrasFallo', () => {
    const T0 = 1_000_000;
    const H = REINTENTO_POSTERGADO_MS;
    const fallar = (
      previo: EstadoPostergado | undefined,
      extra: Partial<Parameters<typeof registrarFallo>[1]> = {},
    ) =>
      registrarFallo(previo, {
        fallo: 'TRANSITORIO',
        sinCosto: false,
        ahora: T0,
        inicioCorrida: T0 - 1000,
        ultimaRespuestaIa: null,
        ...extra,
      });

    it('primer fallo: prueba de IA viva = la IA contestó ANTES en la misma corrida', () => {
      expect(fallar(undefined)).toEqual({
        intentos: 1,
        conIa: 0,
        primerFallo: T0,
        ultimoIntento: T0,
        retirado: false,
      });
      expect(fallar(undefined, { ultimaRespuestaIa: T0 - 500 }).conIa).toBe(1);
      // Contestó en una corrida ANTERIOR: no prueba nada de ésta.
      expect(fallar(undefined, { ultimaRespuestaIa: T0 - 5000 }).conIa).toBe(0);
    });

    it('siguientes: cuenta si la IA contestó a otro DESPUÉS de que éste empezó a fallar', () => {
      const e1 = fallar(undefined);
      const sinPrueba = fallar(e1, { ahora: T0 + H, ultimaRespuestaIa: null });
      expect(sinPrueba).toMatchObject({
        intentos: 2,
        conIa: 0,
        primerFallo: T0,
        ultimoIntento: T0 + H,
      });
      const conPrueba = fallar(e1, {
        ahora: T0 + H,
        ultimaRespuestaIa: T0 + 10,
      });
      expect(conPrueba).toMatchObject({ intentos: 2, conIa: 1 });
      // La respuesta es de ANTES de su primer fallo: no cuenta.
      expect(
        fallar(e1, { ahora: T0 + H, ultimaRespuestaIa: T0 - 10 }).conIa,
      ).toBe(0);
    });

    it('RESPUESTA_IA prueba sola que la IA vive; sin costo y Storage solo mueven la hora', () => {
      expect(fallar(undefined, { fallo: 'RESPUESTA_IA' })).toMatchObject({
        intentos: 1,
        conIa: 1,
      });
      expect(
        fallar(undefined, { sinCosto: true, ultimaRespuestaIa: T0 }),
      ).toMatchObject({ intentos: 0, conIa: 0, ultimoIntento: T0 });
      const s = fallar(undefined, { fallo: 'STORAGE', ultimaRespuestaIa: T0 });
      expect(s).toMatchObject({ intentos: 0, conIa: 0 });
      expect(fallar(s, { fallo: 'STORAGE', ahora: T0 + H })).toMatchObject({
        intentos: 0,
        ultimoIntento: T0 + H,
        primerFallo: T0,
      });
    });

    it('ESCRITURA suma intento (la IA ya cobró) pero nunca conIa', () => {
      expect(
        fallar(undefined, { fallo: 'ESCRITURA', ultimaRespuestaIa: T0 }),
      ).toMatchObject({ intentos: 1, conIa: 0 });
    });

    it('destino: sella con 3 fallos con la IA viva, retira con 6 intentos sin prueba', () => {
      expect(FALLOS_CON_IA_PARA_SELLAR).toBe(3);
      expect(INTENTOS_MAX_POR_GASTO).toBe(6);
      expect(destinoTrasFallo({ intentos: 2, conIa: 2 }, 'TRANSITORIO')).toBe(
        'POSTERGAR',
      );
      expect(destinoTrasFallo({ intentos: 3, conIa: 3 }, 'TRANSITORIO')).toBe(
        'SELLAR',
      );
      expect(destinoTrasFallo({ intentos: 3, conIa: 3 }, 'RESPUESTA_IA')).toBe(
        'SELLAR',
      );
      expect(destinoTrasFallo({ intentos: 5, conIa: 0 }, 'TRANSITORIO')).toBe(
        'POSTERGAR',
      );
      expect(destinoTrasFallo({ intentos: 6, conIa: 2 }, 'TRANSITORIO')).toBe(
        'RETIRAR',
      );
      // Un sello que no se pudo escribir no se vuelve a «sellar» por ahí.
      expect(destinoTrasFallo({ intentos: 4, conIa: 3 }, 'ESCRITURA')).toBe(
        'POSTERGAR',
      );
      expect(destinoTrasFallo({ intentos: 6, conIa: 3 }, 'ESCRITURA')).toBe(
        'RETIRAR',
      );
    });

    it('caso real: foto que siempre truena con la IA viva ⇒ 3 lecturas y se sella', () => {
      let e: EstadoPostergado | undefined;
      let lecturas = 0;
      let destino = 'POSTERGAR';
      for (let i = 0; destino === 'POSTERGAR' && i < 50; i += 1) {
        lecturas += 1;
        e = fallar(e, {
          ahora: T0 + i * H,
          // La IA le contestó a otro gasto en esa misma corrida.
          ultimaRespuestaIa: T0 + i * H - 1,
          inicioCorrida: T0 + i * H - 2,
        });
        destino = destinoTrasFallo(e, 'TRANSITORIO');
      }
      expect(destino).toBe('SELLAR');
      expect(lecturas).toBe(3);
    });

    it('caso real: pyservices caído toda la noche ⇒ nadie se sella ni se retira', () => {
      let e: EstadoPostergado | undefined;
      for (let i = 0; i < 24; i += 1) {
        e = fallar(e, {
          ahora: T0 + i * H,
          sinCosto: true,
          ultimaRespuestaIa: T0 - 10 * H,
        });
        expect(destinoTrasFallo(e, 'TRANSITORIO')).toBe('POSTERGAR');
      }
      // Colgado (timeouts, sí cuentan): sin respuestas de la IA no hay
      // sello; tras 6 intentos sale de la cola (sin escribir nada).
      let c: EstadoPostergado | undefined;
      const destinos: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        c = fallar(c, { ahora: T0 + i * H, ultimaRespuestaIa: T0 - 10 * H });
        destinos.push(destinoTrasFallo(c, 'TRANSITORIO'));
      }
      expect(destinos).toEqual([
        'POSTERGAR',
        'POSTERGAR',
        'POSTERGAR',
        'POSTERGAR',
        'POSTERGAR',
        'RETIRAR',
      ]);
    });
  });

  it('archivosDelComprobante / mismoComprobante', () => {
    expect(
      archivosDelComprobante(' u/f.jpg ', {
        fotos_adicionales: ['u/h2.jpg', 'u/f.jpg', 'u/h3.jpg'],
      }),
    ).toEqual(['u/f.jpg', 'u/h2.jpg', 'u/h3.jpg']);
    // PDF/Excel: solo el documento (las hojas no se mandan).
    expect(
      archivosDelComprobante('u/f.pdf', { fotos_adicionales: ['u/h2.jpg'] }),
    ).toEqual(['u/f.pdf']);
    expect(archivosDelComprobante(null, null)).toEqual([]);
    expect(archivosDelComprobante('  ', null)).toEqual([]);
    expect(mismoComprobante(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(mismoComprobante(['a'], ['b'])).toBe(false);
    expect(mismoComprobante(['a', 'b'], ['a'])).toBe(false);
    expect(mismoComprobante(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(mismoComprobante([], [])).toBe(true);
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
    // 422 de /vision/gasto DESPUÉS de que la IA contestó (y cobró).
    ['Respuesta truncada por max_tokens (subir el límite)', 'RESPUESTA_IA'],
    ['Respuesta sin JSON: No puedo leer la foto', 'RESPUESTA_IA'],
    ['JSON inválido (Expecting value pos 12): …{"monto": }…', 'RESPUESTA_IA'],
    ['No se pudo interpretar el ticket', 'RESPUESTA_IA'],
    ['1 validation error for GastoTicketResponse confianza', 'RESPUESTA_IA'],
    // Lo que escribió el modelo NO decide: manda el inicio del texto.
    [
      'Respuesta sin JSON: la foto pesa demasiado y no pudo leer la foto',
      'RESPUESTA_IA',
    ],
    // 422 ANTES de llamar a la IA: el archivo es el problema.
    [
      'Formato .xls (Excel viejo) no soportado: guárdalo como .xlsx',
      'COMPROBANTE',
    ],
    ['El archivo Excel/CSV está vacío o no se pudo leer', 'COMPROBANTE'],
  ])('clasificarMotivoLectura(%p) ⇒ %s', (motivo, esperado) => {
    expect(clasificarMotivoLectura(motivo)).toBe(esperado);
  });

  it.each([
    ['Sin conexión con pyservices: fetch failed', true],
    ['pyservices 502', true],
    ['pyservices 503', true],
    ['pyservices 504', true],
    [
      'La IA está saturada (límite de peticiones): espera un minuto y reintenta',
      true,
    ],
    [
      'La IA está saturada o caída por el momento: reintenta en unos minutos',
      true,
    ],
    ['pyservices 500', false],
    ['pyservices 5000', false],
    ['La lectura tardó demasiado (timeout API→pyservices)', false],
    ['Claude no disponible (400): Unable to download the file', false],
    ['algo nuevo que no conocemos', false],
    [null, false],
  ])('falloSinCosto(%p) ⇒ %p', (motivo, esperado) => {
    expect(falloSinCosto(motivo)).toBe(esperado);
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
        motivo: 'Respuesta truncada por max_tokens (subir el límite)',
      }),
    ).toEqual({
      tipo: 'FALLO',
      fallo: 'RESPUESTA_IA',
      motivo: 'Respuesta truncada por max_tokens (subir el límite)',
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
