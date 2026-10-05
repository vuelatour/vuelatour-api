import {
  COMBUSTIBLES,
  COMBUSTIBLE_DEFAULT,
  MENSAJE_COMBUSTIBLE_INVALIDO,
  ajustarCombustiblePatch,
  anexarLineaUnica,
  avisoCombustibleCorregido,
  avisoFilaCombustible,
  combustibleDeTexto,
  etiquetaCombustible,
  leerNotaCombustible,
  mensajeTipoCombustibleFilaInvalido,
  normalizarCombustible,
  notasCombustible,
  quitarNotaCombustible,
  reescribirLineaCombustible,
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
    // Etiqueta Y código: la API solo acepta el código (quien integre directo
    // y siga el mensaje no debe mandar «Gasavión» y recibir el mismo 400).
    expect(MENSAJE_COMBUSTIBLE_INVALIDO).toBe(
      'El combustible del avión es Gasavión (AVGAS, pistón) o Turbosina (TURBOSINA, turbina).',
    );
  });

  it('combustibleDeTexto (plantilla de la carga masiva): código o etiqueta ⇒ código', () => {
    for (const v of [
      'AVGAS',
      'avgas',
      ' Gasavión ',
      'GASAVIÓN',
      'gasavion',
      'Gas avión',
      'gas-avion',
    ]) {
      expect(combustibleDeTexto(v)).toBe('AVGAS');
    }
    for (const v of ['TURBOSINA', 'Turbosina', 'turbosina ']) {
      expect(combustibleDeTexto(v)).toBe('TURBOSINA');
    }
    for (const v of ['DIESEL', 'Jet-A', 'Gas', '', '   ', null, undefined, 3]) {
      expect(combustibleDeTexto(v)).toBeNull();
    }
    // Lo de BD/DTO sigue aceptando SOLO códigos.
    expect(normalizarCombustible('Gasavión')).toBeNull();
    expect(mensajeTipoCombustibleFilaInvalido('DIESEL')).toBe(
      "Tipo de combustible 'DIESEL' inválido: escribe Gasavión (AVGAS) o Turbosina (TURBOSINA).",
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

  it('etiquetas es-MX: el cliente llama «Gasavión» al AVGAS', () => {
    expect(etiquetaCombustible('AVGAS')).toBe('Gasavión');
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
        nota: '⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar',
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
        '⚠ se capturó Gasavión pero el avión carga Turbosina: se corrigió a Turbosina — revisar',
      );
      expect(
        resolverTipoCombustible({
          capturado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
          motivo: 'cambio_avion',
        }).nota,
      ).toBe(
        '⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
      );
    });
  });

  describe('anexarLineaUnica', () => {
    const linea =
      '⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar';
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
      '⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar';
    const N621 =
      '⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar';
    const SIN_MAT =
      '⚠ se capturó Gasavión pero el avión carga Turbosina: se corrigió a Turbosina — revisar';
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

    it('tolerancia: también lee la forma vieja con códigos AVGAS/TURBOSINA', () => {
      const VIEJA_PEV =
        '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar';
      const VIEJA_N621 =
        '⚠ el gasto traía AVGAS pero el N621TX carga TURBOSINA: se corrigió a TURBOSINA — revisar';
      expect(leerNotaCombustible(VIEJA_PEV)).toEqual(leerNotaCombustible(PEV));
      expect(leerNotaCombustible(VIEJA_N621)).toEqual(
        leerNotaCombustible(N621),
      );
      expect(
        quitarNotaCombustible(`Carga en Chetumal\n${VIEJA_PEV}\n${TRAMO}`),
      ).toBe(`Carga en Chetumal\n${TRAMO}`);
    });

    it('no confunde otras notas ⚠ ni texto libre', () => {
      expect(leerNotaCombustible(TRAMO)).toBeNull();
      // Un combustible que no es etiqueta ni código exacto no es la nota.
      expect(
        leerNotaCombustible(
          '⚠ se capturó Diesel pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar',
        ),
      ).toBeNull();
      expect(
        leerNotaCombustible(
          '⚠ se capturó Turbosina pero el XB-PEV carga Avgas: se corrigió a Avgas — revisar',
        ),
      ).toBeNull();
      expect(leerNotaCombustible('Carga en Chetumal')).toBeNull();
      expect(leerNotaCombustible(`Nota: ${PEV}`)).toBeNull();
      expect(leerNotaCombustible(null)).toBeNull();
    });

    it('el «carga X» (combustible del avión) también se valida', () => {
      expect(
        leerNotaCombustible(
          '⚠ se capturó Turbosina pero el XB-PEV carga Diesel: se corrigió a Gasavión — revisar',
        ),
      ).toBeNull();
    });

    it('texto humano DESPUÉS de «— revisar» ⇒ ya no es la nota: no se lee ni se retira', () => {
      const conTexto = `${PEV} (dice el piloto que fue error)`;
      expect(leerNotaCombustible(conTexto)).toBeNull();
      expect(quitarNotaCombustible(conTexto)).toBe(conTexto);
      expect(quitarNotaCombustible(`Carga en Chetumal\n${conTexto}`)).toBe(
        `Carga en Chetumal\n${conTexto}`,
      );
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
      '⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar';

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
          'Carga en Chetumal\n⚠ se capturó Turbosina pero el N4142R carga Gasavión: se corrigió a Gasavión — revisar',
        marcarVistoBueno: false,
      });
    });

    it('notas viejas con DOS líneas que se contradicen ⇒ se retiran ambas y manda la captura original', () => {
      const N621 =
        '⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar';
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
          'Carga en Chetumal\n⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
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

    it('corrige ⇒ el renglón «Combustible …» de la app queda con el tipo del avión ANTES de la nota ⚠', () => {
      expect(
        ajustarCombustiblePatch({
          notas: 'Combustible TURBOSINA · 74 L · Chetumal',
          guardado: 'AVGAS',
          enviado: 'TURBOSINA',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({
        tipo: 'AVGAS',
        notas: `Combustible AVGAS · 74 L · Chetumal\n${PEV}`,
        marcarVistoBueno: true,
      });
      // Mover sin nota previa a un avión de otro combustible también corrige.
      expect(
        ajustarCombustiblePatch({
          notas: 'Combustible AVGAS · 74 L · Chetumal',
          guardado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        })?.notas,
      ).toBe(
        'Combustible TURBOSINA · 74 L · Chetumal\n⚠ el gasto traía Gasavión pero el N621TX carga Turbosina: se corrigió a Turbosina — revisar',
      );
    });

    it('caso #280 al revés con el renglón de la app: se retira la nota y el renglón vuelve al tipo FINAL', () => {
      expect(
        ajustarCombustiblePatch({
          notas: `Combustible AVGAS · 74 L · Chetumal\n${PEV}`,
          guardado: 'AVGAS',
          delAvion: 'TURBOSINA',
          matricula: 'N621TX',
        }),
      ).toMatchObject({
        tipo: 'TURBOSINA',
        notas: 'Combustible TURBOSINA · 74 L · Chetumal',
        marcarVistoBueno: false,
      });
      // A otro avión del MISMO combustible: el renglón ya coincide.
      expect(
        ajustarCombustiblePatch({
          notas: `Combustible AVGAS · 74 L · Chetumal\n${PEV}`,
          guardado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'N4142R',
        })?.notas,
      ).toBe(
        'Combustible AVGAS · 74 L · Chetumal\n⚠ se capturó Turbosina pero el N4142R carga Gasavión: se corrigió a Gasavión — revisar',
      );
    });

    it('sin corrección ni cambio de avión el renglón de la app NO se toca', () => {
      const notas = 'Combustible TURBOSINA · 74 L · Chetumal';
      expect(
        ajustarCombustiblePatch({
          notas,
          guardado: 'AVGAS',
          enviado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        })?.notas,
      ).toBe(notas);
    });

    it('la oficina elige a mano el tipo del avión (XB-PEV: TURBOSINA ⇒ AVGAS) ⇒ el renglón también pasa a AVGAS', () => {
      // Sin corrección (la oficina ya mandó el del avión) pero el tipo
      // GUARDADO cambia: el renglón de la app lo sigue. Antes quedaba
      // «Combustible TURBOSINA · 74 L …» en un gasto AVGAS (síntoma #280).
      expect(
        ajustarCombustiblePatch({
          notas: 'Combustible TURBOSINA · 74 L · $32/L · aeropuerto CTM',
          guardado: 'TURBOSINA',
          enviado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({
        tipo: 'AVGAS',
        notas: 'Combustible AVGAS · 74 L · $32/L · aeropuerto CTM',
        marcarVistoBueno: false,
      });
    });

    it('relleno (tipo guardado vacío) ⇒ el renglón de la app queda con el tipo del avión, sin nota', () => {
      // El PATCH no trae el tipo (mueve el gasto) …
      expect(
        ajustarCombustiblePatch({
          notas: 'Combustible TURBOSINA · 74 L',
          guardado: null,
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({
        tipo: 'AVGAS',
        notas: 'Combustible AVGAS · 74 L',
        marcarVistoBueno: false,
      });
      // … o trae el del avión sobre un guardado vacío.
      expect(
        ajustarCombustiblePatch({
          notas: 'Combustible TURBOSINA · 74 L',
          guardado: null,
          enviado: 'AVGAS',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        })?.notas,
      ).toBe('Combustible AVGAS · 74 L');
    });

    it('la MISMA nota en la forma vieja (códigos) no se duplica', () => {
      const vieja =
        '⚠ se capturó TURBOSINA pero el XB-PEV carga AVGAS: se corrigió a AVGAS — revisar';
      const notas = `Carga en Chetumal\n${vieja}`;
      expect(
        ajustarCombustiblePatch({
          notas,
          guardado: 'AVGAS',
          enviado: 'TURBOSINA',
          delAvion: 'AVGAS',
          matricula: 'XB-PEV',
        }),
      ).toMatchObject({ tipo: 'AVGAS', notas, marcarVistoBueno: true });
      // La vieja de OTRO avión se retira igual que la nueva.
      expect(
        ajustarCombustiblePatch({
          notas,
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

  describe('reescribirLineaCombustible (renglón «Combustible …» de la app)', () => {
    it('reescribe SOLO el código del primer renglón que lo empieza', () => {
      expect(
        reescribirLineaCombustible(
          'Combustible TURBOSINA · 74 L · Chetumal',
          'AVGAS',
        ),
      ).toBe('Combustible AVGAS · 74 L · Chetumal');
      expect(
        reescribirLineaCombustible(
          'Ticket 0585\nCombustible AVGAS · 120 L\nTarjeta ****0585',
          'TURBOSINA',
        ),
      ).toBe('Ticket 0585\nCombustible TURBOSINA · 120 L\nTarjeta ****0585');
      // Renglón que es SOLO el código.
      expect(reescribirLineaCombustible('Combustible TURBOSINA', 'AVGAS')).toBe(
        'Combustible AVGAS',
      );
    });

    it('una sola reescritura: los renglones siguientes quedan como estaban', () => {
      expect(
        reescribirLineaCombustible(
          'Combustible TURBOSINA · 74 L\nCombustible TURBOSINA · 20 L',
          'AVGAS',
        ),
      ).toBe('Combustible AVGAS · 74 L\nCombustible TURBOSINA · 20 L');
    });

    it('sin renglón, ya coincide o código inválido ⇒ intacto (misma referencia)', () => {
      const sinRenglon = 'Carga en Chetumal\nTarjeta ****0585';
      expect(reescribirLineaCombustible(sinRenglon, 'AVGAS')).toBe(sinRenglon);
      const coincide = 'Combustible AVGAS · 74 L\nCombustible TURBOSINA · 20 L';
      expect(reescribirLineaCombustible(coincide, 'AVGAS')).toBe(coincide);
      const original = 'Combustible TURBOSINA · 74 L';
      expect(reescribirLineaCombustible(original, 'DIESEL')).toBe(original);
      expect(reescribirLineaCombustible(original, null)).toBe(original);
      expect(reescribirLineaCombustible(null, 'AVGAS')).toBeNull();
      expect(reescribirLineaCombustible(undefined, 'AVGAS')).toBeUndefined();
      expect(reescribirLineaCombustible('', 'AVGAS')).toBe('');
    });

    it('no toca «Combustible …» a media línea, otra palabra ni la nota ⚠', () => {
      const medio = 'Pagado en efectivo. Combustible TURBOSINA · 74 L';
      expect(reescribirLineaCombustible(medio, 'AVGAS')).toBe(medio);
      const sangria = '  Combustible TURBOSINA · 74 L';
      expect(reescribirLineaCombustible(sangria, 'AVGAS')).toBe(sangria);
      const otraPalabra = 'Combustible TURBOSINAS de prueba';
      expect(reescribirLineaCombustible(otraPalabra, 'AVGAS')).toBe(
        otraPalabra,
      );
      const minusculas = 'combustible turbosina · 74 L';
      expect(reescribirLineaCombustible(minusculas, 'AVGAS')).toBe(minusculas);
      const conNota =
        'Carga en Chetumal\n⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar';
      expect(reescribirLineaCombustible(conNota, 'TURBOSINA')).toBe(conNota);
    });

    it('acepta el código en minúsculas como destino y escribe el código canónico', () => {
      expect(
        reescribirLineaCombustible('Combustible AVGAS · 74 L', ' turbosina '),
      ).toBe('Combustible TURBOSINA · 74 L');
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
        'Se capturó Turbosina pero el XB-PEV carga Gasavión (74 L · $2,738.50 MXN). Se guardó como Gasavión y quedó para revisión.',
    });
    // Sin litros ni matrícula.
    expect(
      avisoCombustibleCorregido({ resultado, monto: 1200, moneda: 'USD' })
        .cuerpo,
    ).toBe(
      'Se capturó Turbosina pero el avión carga Gasavión ($1,200 USD). Se guardó como Gasavión y quedó para revisión.',
    );
  });

  it('avisos de la carga masiva: preview y guardada; null si no se corrige', () => {
    const corregido = resolverTipoCombustible({
      capturado: 'TURBOSINA',
      delAvion: 'AVGAS',
    });
    expect(avisoFilaCombustible(corregido, 'XB-PEV', 'preview')).toBe(
      'La fila dice Turbosina pero el XB-PEV carga Gasavión: se guardará como Gasavión y quedará marcada para revisión.',
    );
    expect(avisoFilaCombustible(corregido, 'XB-PEV', 'guardada')).toBe(
      'La fila decía Turbosina pero el XB-PEV carga Gasavión: se guardó como Gasavión y quedó marcada para revisión.',
    );
    const relleno = resolverTipoCombustible({
      capturado: null,
      delAvion: 'AVGAS',
    });
    expect(avisoFilaCombustible(relleno, 'XB-PEV', 'preview')).toBeNull();
  });
});
