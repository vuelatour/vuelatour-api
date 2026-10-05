import {
  COMBUSTIBLES,
  COMBUSTIBLE_DEFAULT,
  MENSAJE_COMBUSTIBLE_INVALIDO,
  anexarLineaUnica,
  avisoCombustibleCorregido,
  avisoFilaCombustible,
  etiquetaCombustible,
  normalizarCombustible,
  resolverTipoCombustible,
} from './combustible.util';

/**
 * COMBUSTIBLE POR AERONAVE (5-oct-2026, API 0.0.56). Caso real: Luis capturó
 * 74 L para el XB-PEV (vuelo #280, Chetumal) y eligió «Turbosina»; el PEV
 * solo carga AVGAS. La regla única corrige la carga al combustible del avión
 * y deja la nota «⚠ … — revisar».
 */
describe('combustible.util', () => {
  it('catálogo: AVGAS y TURBOSINA, default AVGAS', () => {
    expect(COMBUSTIBLES).toEqual(['AVGAS', 'TURBOSINA']);
    expect(COMBUSTIBLE_DEFAULT).toBe('AVGAS');
    expect(MENSAJE_COMBUSTIBLE_INVALIDO).toBe(
      'El combustible del avión es AVGAS (pistón) o TURBOSINA (turbina).',
    );
  });

  it('normaliza mayúsculas/espacios y rechaza lo que no es del catálogo', () => {
    expect(normalizarCombustible(' turbosina ')).toBe('TURBOSINA');
    expect(normalizarCombustible('AVGAS')).toBe('AVGAS');
    expect(normalizarCombustible('DIESEL')).toBeNull();
    expect(normalizarCombustible('')).toBeNull();
    expect(normalizarCombustible(null)).toBeNull();
    expect(normalizarCombustible(undefined)).toBeNull();
    expect(normalizarCombustible(3)).toBeNull();
  });

  it('etiquetas es-MX', () => {
    expect(etiquetaCombustible('AVGAS')).toBe('Avgas');
    expect(etiquetaCombustible('TURBOSINA')).toBe('Turbosina');
    expect(etiquetaCombustible(null)).toBe('—');
    expect(etiquetaCombustible('X')).toBe('—');
  });

  describe('resolverTipoCombustible', () => {
    it('caso real XB-PEV: TURBOSINA capturada ⇒ AVGAS + nota + corregido', () => {
      const r = resolverTipoCombustible({
        capturado: 'TURBOSINA',
        delAvion: 'AVGAS',
        matricula: 'XB-PEV',
      });
      expect(r).toEqual({
        tipo: 'AVGAS',
        nota: '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar',
        corregido: true,
        rellenado: false,
        capturado: 'TURBOSINA',
        delAvion: 'AVGAS',
      });
    });

    it('sin el combustible del avión (migración sin aplicar o sin dato) ⇒ tal cual, sin nota', () => {
      for (const delAvion of [undefined, null, '', 'DIESEL']) {
        const r = resolverTipoCombustible({
          capturado: 'TURBOSINA',
          delAvion,
          matricula: 'XB-PEV',
        });
        expect(r.tipo).toBe('TURBOSINA');
        expect(r.nota).toBeNull();
        expect(r.corregido).toBe(false);
        expect(r.rellenado).toBe(false);
      }
      expect(
        resolverTipoCombustible({ capturado: undefined, delAvion: undefined })
          .tipo,
      ).toBeNull();
    });

    it('capturado vacío ⇒ se rellena con el del avión, sin nota ni visto bueno', () => {
      for (const capturado of [undefined, null, '', '  ']) {
        const r = resolverTipoCombustible({
          capturado,
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        });
        expect(r.tipo).toBe('TURBOSINA');
        expect(r.nota).toBeNull();
        expect(r.corregido).toBe(false);
        expect(r.rellenado).toBe(true);
      }
    });

    it('igual al del avión ⇒ nada que hacer', () => {
      const r = resolverTipoCombustible({
        capturado: 'AVGAS',
        delAvion: 'AVGAS',
        matricula: 'XB-PEV',
      });
      expect(r).toMatchObject({
        tipo: 'AVGAS',
        nota: null,
        corregido: false,
        rellenado: false,
      });
    });

    it('sin matrícula ⇒ «el avión»; motivo cambio_avion ⇒ «el gasto traía»', () => {
      expect(
        resolverTipoCombustible({ capturado: 'AVGAS', delAvion: 'TURBOSINA' })
          .nota,
      ).toBe(
        '⚠ se capturó AVGAS pero el avión carga TURBOSINA: se corrigió a TURBOSINA — revisar',
      );
      expect(
        resolverTipoCombustible({
          capturado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
          motivo: 'cambio_avion',
        }).nota,
      ).toBe(
        '⚠ el gasto traía AVGAS pero el N621TX carga TURBOSINA: se corrigió a TURBOSINA — revisar',
      );
    });
  });

  describe('anexarLineaUnica', () => {
    const linea =
      '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar';
    it('sin notas ⇒ la línea sola', () => {
      expect(anexarLineaUnica(null, linea)).toBe(linea);
      expect(anexarLineaUnica('', linea)).toBe(linea);
      expect(anexarLineaUnica(undefined, linea)).toBe(linea);
    });
    it('con notas ⇒ al final; si ya está como renglón, no se repite', () => {
      const una = anexarLineaUnica('Carga en Chetumal', linea);
      expect(una).toBe(`Carga en Chetumal\n${linea}`);
      expect(anexarLineaUnica(una, linea)).toBe(una);
      // Un renglón que solo la CONTIENE no cuenta como la misma línea.
      expect(anexarLineaUnica(`Nota: ${linea}`, linea)).toBe(
        `Nota: ${linea}\n${linea}`,
      );
    });
  });

  it('aviso a oficina con litros, monto y etiquetas', () => {
    const resultado = resolverTipoCombustible({
      capturado: 'TURBOSINA',
      delAvion: 'AVGAS',
      matricula: 'XB-PEV',
    });
    expect(
      avisoCombustibleCorregido({
        resultado,
        matricula: 'XB-PEV',
        litros: 74,
        monto: 2738.5,
        moneda: 'MXN',
      }),
    ).toEqual({
      titulo: 'Carga de combustible corregida',
      cuerpo:
        'Carga de combustible corregida: se capturó Turbosina pero el XB-PEV carga Avgas (74 L · $2,738.50 MXN). Se guardó como Avgas y quedó para revisión.',
    });
    // Sin litros ni matrícula.
    expect(
      avisoCombustibleCorregido({ resultado, monto: 1200, moneda: 'USD' })
        .cuerpo,
    ).toBe(
      'Carga de combustible corregida: se capturó Turbosina pero el avión carga Avgas ($1,200 USD). Se guardó como Avgas y quedó para revisión.',
    );
  });

  it('avisos de la carga masiva: preview y guardada; null si no se corrige', () => {
    const corregido = resolverTipoCombustible({
      capturado: 'TURBOSINA',
      delAvion: 'AVGAS',
    });
    expect(avisoFilaCombustible(corregido, 'XB-PEV', 'preview')).toBe(
      'La fila dice Turbosina pero el XB-PEV carga Avgas: se guardará como Avgas y quedará marcada para revisión.',
    );
    expect(avisoFilaCombustible(corregido, 'XB-PEV', 'guardada')).toBe(
      'La fila decía Turbosina pero el XB-PEV carga Avgas: se guardó como Avgas y quedó marcada para revisión.',
    );
    const relleno = resolverTipoCombustible({
      capturado: null,
      delAvion: 'AVGAS',
    });
    expect(avisoFilaCombustible(relleno, 'XB-PEV', 'preview')).toBeNull();
  });
});
