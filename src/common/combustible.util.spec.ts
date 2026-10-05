import {
  COMBUSTIBLES,
  COMBUSTIBLE_DEFAULT,
  MENSAJE_COMBUSTIBLE_INVALIDO,
  ajustarCombustiblePatch,
  anexarLineaUnica,
  avisoCombustibleCorregido,
  avisoFilaCombustible,
  etiquetaCombustible,
  leerNotaCombustible,
  normalizarCombustible,
  notasCombustible,
  quitarNotaCombustible,
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

  describe('notas de combustible: leer y quitar', () => {
    const PEV =
      '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar';
    const N621 =
      '⚠ el gasto traía AVGAS pero el N621TX carga TURBOSINA: se corrigió a TURBOSINA — revisar';
    const SIN_MAT =
      '⚠ se capturó AVGAS pero el avión carga TURBOSINA: se corrigió a TURBOSINA — revisar';
    const TRAMO =
      '⚠ el gasto se asignó a XB-PEV pero el tramo CTM→CUN lo voló N621TX: en balance y reparto cuenta al avión del tramo — revisar';

    it('lee las tres formas que escribe resolverTipoCombustible', () => {
      expect(leerNotaCombustible(PEV)).toEqual({
        motivo: 'captura',
        capturado: 'TURBOSINA',
        matricula: 'XB-PEV',
        corregidoA: 'AVGAS',
      });
      expect(leerNotaCombustible(`  ${N621}  `)).toEqual({
        motivo: 'cambio_avion',
        capturado: 'AVGAS',
        matricula: 'N621TX',
        corregidoA: 'TURBOSINA',
      });
      expect(leerNotaCombustible(SIN_MAT)?.matricula).toBeNull();
    });

    it('no confunde otras notas ⚠ ni texto libre', () => {
      expect(leerNotaCombustible(TRAMO)).toBeNull();
      expect(leerNotaCombustible('Carga en Chetumal')).toBeNull();
      expect(leerNotaCombustible(`Nota: ${PEV}`)).toBeNull();
      expect(leerNotaCombustible(null)).toBeNull();
    });

    it('notasCombustible: en orden, la más vieja primero', () => {
      expect(
        notasCombustible(`Carga en Chetumal\n${PEV}\n${TRAMO}\n${N621}`).map(
          (n) => n.matricula,
        ),
      ).toEqual(['XB-PEV', 'N621TX']);
      expect(notasCombustible(null)).toEqual([]);
    });

    it('quitarNotaCombustible: retira SOLO las de combustible; null si no queda nada', () => {
      expect(
        quitarNotaCombustible(`Carga en Chetumal\n${PEV}\n${TRAMO}\n${N621}`),
      ).toBe(`Carga en Chetumal\n${TRAMO}`);
      expect(quitarNotaCombustible(`${PEV}\n${N621}`)).toBeNull();
      expect(quitarNotaCombustible('Ticket 0585')).toBe('Ticket 0585');
      expect(quitarNotaCombustible(null)).toBeNull();
      expect(quitarNotaCombustible('')).toBeNull();
    });
  });

  describe('ajustarCombustiblePatch (PATCH de una carga GAS)', () => {
    const PEV =
      '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar';

    it('caso #280 al revés: la carga corregida en el PEV se mueve al N621TX ⇒ vuelve a TURBOSINA, sin nota y sin otro visto bueno', () => {
      expect(
        ajustarCombustiblePatch({
          notas: `Carga en Chetumal\n${PEV}`,
          guardado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        }),
      ).toMatchObject({
        tipo: 'TURBOSINA',
        notas: 'Carga en Chetumal',
        marcarVistoBueno: false,
      });
    });

    it('el formulario completo reenvía el tipo guardado al mover de avión ⇒ igual que si no lo mandara', () => {
      expect(
        ajustarCombustiblePatch({
          notas: PEV,
          guardado: 'AVGAS',
          enviado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        }),
      ).toMatchObject({
        tipo: 'TURBOSINA',
        notas: null,
        marcarVistoBueno: false,
      });
    });

    it('a otro avión del MISMO combustible ⇒ la nota se reescribe con el avión nuevo, sin otro visto bueno', () => {
      expect(
        ajustarCombustiblePatch({
          notas: `Carga en Chetumal\n${PEV}`,
          guardado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'N4142R',
        }),
      ).toMatchObject({
        tipo: 'AVGAS',
        notas:
          'Carga en Chetumal\n⚠ se capturó TURBOSINA pero el N4142R carga AVGAS: se corrigió a AVGAS — revisar',
        marcarVistoBueno: false,
      });
    });

    it('notas viejas con DOS líneas que se contradicen ⇒ se retiran ambas y manda la captura original', () => {
      const N621 =
        '⚠ el gasto traía AVGAS pero el N621TX carga TURBOSINA: se corrigió a TURBOSINA — revisar';
      expect(
        ajustarCombustiblePatch({
          notas: `${PEV}\n${N621}`,
          guardado: 'TURBOSINA',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        }),
      ).toMatchObject({
        tipo: 'TURBOSINA',
        notas: null,
        marcarVistoBueno: false,
      });
    });

    it('sin nota previa, mover la carga a un avión de otro combustible ⇒ «el gasto traía» + visto bueno', () => {
      expect(
        ajustarCombustiblePatch({
          notas: 'Carga en Chetumal',
          guardado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        }),
      ).toMatchObject({
        tipo: 'TURBOSINA',
        notas:
          'Carga en Chetumal\n⚠ el gasto traía AVGAS pero el N621TX carga TURBOSINA: se corrigió a TURBOSINA — revisar',
        marcarVistoBueno: true,
      });
    });

    it('mismo avión: la nota se conserva y mandar otra vez el tipo equivocado vuelve a pedir visto bueno sin duplicarla', () => {
      const notas = `Carga en Chetumal\n${PEV}`;
      expect(
        ajustarCombustiblePatch({
          notas,
          guardado: 'AVGAS',
          enviado: 'TURBOSINA',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({ tipo: 'AVGAS', notas, marcarVistoBueno: true });
      // Reenviar el valor correcto (formulario completo) no toca nada.
      expect(
        ajustarCombustiblePatch({
          notas,
          guardado: 'AVGAS',
          enviado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({ tipo: 'AVGAS', notas, marcarVistoBueno: false });
    });

    it('vacío ⇒ se rellena sin nota; avión sin dato ⇒ null (no se toca)', () => {
      expect(
        ajustarCombustiblePatch({
          notas: null,
          guardado: null,
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({ tipo: 'AVGAS', notas: null, marcarVistoBueno: false });
      expect(
        ajustarCombustiblePatch({
          notas: PEV,
          guardado: 'AVGAS',
          delAvion: null,
          matricula: 'N621TX',
        }),
      ).toBeNull();
    });
  });

  it('aviso a oficina con litros, monto y etiquetas (el cuerpo no repite el título)', () => {
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
        'Se capturó Turbosina pero el XB-PEV carga Avgas (74 L · $2,738.50 MXN). Se guardó como Avgas y quedó para revisión.',
    });
    // Sin litros ni matrícula.
    expect(
      avisoCombustibleCorregido({ resultado, monto: 1200, moneda: 'USD' })
        .cuerpo,
    ).toBe(
      'Se capturó Turbosina pero el avión carga Avgas ($1,200 USD). Se guardó como Avgas y quedó para revisión.',
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
