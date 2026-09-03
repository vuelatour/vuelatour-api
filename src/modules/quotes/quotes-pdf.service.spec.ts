import { escalasVisiblesPdf } from './quotes-pdf.service';

/**
 * escalasVisiblesPdf: ÚNICO punto de filtrado de pdf_oculto para el PDF de
 * cotización — visibles renumerados 1..N, ruta con huecos unidos y fechas de
 * traslado que no delatan tramos ocultos. Presentación pura: nada de esto
 * toca precios/desglose/totales.
 */

/** Tramo del snapshot (ruta comercial congelada por calculate/revise). */
function tramo(
  orden: number,
  origen: string,
  destino: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { orden, origen, destino, millas: 100, tiempo_hr: 1, ...extra };
}

/** Escala viva (findEscalas). */
function escala(
  orden: number,
  origen: string,
  destino: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orden,
    origen_iata: origen,
    destino_iata: destino,
    solo_operativa: false,
    pdf_oculto: false,
    // Fecha SOLO del PDF (3-sep): sin captura por default.
    pdf_fecha: null,
    cancelada_at: null,
    fecha_salida_plan: `2026-09-0${orden}T10:00:00.000Z`,
    ...extra,
  };
}

describe('escalasVisiblesPdf', () => {
  it('filtra los ocultos, renumera 1..N y une los huecos de la ruta', () => {
    // Caso del cliente: visibles 1, 4 y 5 → la ruta une lo que queda.
    const r = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'AZP'),
          tramo(2, 'AZP', 'TGZ', { pdf_oculto: true }),
          tramo(3, 'TGZ', 'BZE', { pdf_oculto: true }),
          tramo(4, 'BZE', 'CZM'),
          tramo(5, 'CZM', 'CUN'),
        ],
      },
      escalas: [],
    });
    expect(r.escalas.map((e) => e.orden)).toEqual([1, 2, 3]);
    expect(
      r.escalas.map(
        (e) => `${e.origen_iata as string}→${e.destino_iata as string}`,
      ),
    ).toEqual(['CUN→AZP', 'BZE→CZM', 'CZM→CUN']);
    // Jamás la posición original (4, 5) — delataría los ocultos.
    expect(r.escalas.some((e) => (e.orden as number) > 3)).toBe(false);
    expect(r.ruta).toBe('CUN → AZP → BZE → CZM → CUN');
  });

  it('oculto el PRIMER tramo: la ruta arranca en el primer visible y el traslado inicial usa su fecha_salida_plan', () => {
    const r = escalasVisiblesPdf({
      fecha_vuelo: '2026-09-01T08:00:00.000Z',
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'AZP', { pdf_oculto: true }),
          tramo(2, 'AZP', 'CZM'),
          tramo(3, 'CZM', 'CUN'),
        ],
      },
      escalas: [
        escala(1, 'CUN', 'AZP', { pdf_oculto: true }),
        escala(2, 'AZP', 'CZM'),
        escala(3, 'CZM', 'CUN'),
      ],
    });
    expect(r.ruta).toBe('AZP → CZM → CUN');
    expect(r.escalas.map((e) => e.orden)).toEqual([1, 2]);
    // La fecha del vuelo delataría el tramo oculto CUN→AZP.
    expect(r.fechaTrasladoInicial).toBe('2026-09-02T10:00:00.000Z');
  });

  it('oculto el ÚLTIMO tramo: el traslado final usa la fecha del último visible (fallback a la del vuelo si no hay)', () => {
    const base = {
      fecha_vuelo: '2026-09-01T08:00:00.000Z',
      fecha_traslado_final: '2026-09-03T18:00:00.000Z',
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'CZM'),
          tramo(2, 'CZM', 'MID'),
          tramo(3, 'MID', 'CUN', { pdf_oculto: true }),
        ],
      },
    };
    const conVivas = escalasVisiblesPdf({
      ...base,
      escalas: [
        escala(1, 'CUN', 'CZM'),
        escala(2, 'CZM', 'MID'),
        escala(3, 'MID', 'CUN', { pdf_oculto: true }),
      ],
    });
    expect(conVivas.ruta).toBe('CUN → CZM → MID');
    expect(conVivas.fechaTrasladoFinal).toBe('2026-09-02T10:00:00.000Z');
    expect(conVivas.fechaTrasladoInicial).toBe('2026-09-01T08:00:00.000Z');
    // Sin escalas vivas (no hay fecha por tramo): conserva la del vuelo.
    const sinVivas = escalasVisiblesPdf({ ...base, escalas: [] });
    expect(sinVivas.fechaTrasladoFinal).toBe('2026-09-03T18:00:00.000Z');
  });

  it('todos ocultos: degrada a escalas=[] y ruta null (título cae a origen→destino del vuelo, sin tabla ni mapa)', () => {
    const r = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'CZM', { pdf_oculto: true }),
          tramo(2, 'CZM', 'CUN', { pdf_oculto: true }),
        ],
      },
      escalas: [],
    });
    expect(r.escalas).toEqual([]);
    expect(r.ruta).toBeNull();
    // Las horas del "De un vistazo" NO se filtran (decisión 2-sep): aun con
    // todo oculto salen del snapshot completo.
    expect(r.tiempoTramoSnapMaxHr).toBe(1);
  });

  it('todos ocultos menos uno: queda ese único tramo como 1', () => {
    const r = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'CZM', { pdf_oculto: true }),
          tramo(2, 'CZM', 'CUN'),
        ],
      },
      escalas: [],
    });
    expect(r.escalas.map((e) => e.orden)).toEqual([1]);
    expect(r.ruta).toBe('CZM → CUN');
  });

  it('rama fallback (sin snapshot.tramos): filtra solo_operativa, canceladas (regla 27-jul) y ocultas; renumera', () => {
    const r = escalasVisiblesPdf({
      calculo_snapshot: {},
      escalas: [
        escala(1, 'CUN', 'CZM'),
        escala(2, 'CZM', 'MID', { pdf_oculto: true }),
        escala(3, 'MID', 'CTM', { cancelada_at: '2026-08-30T00:00:00.000Z' }),
        escala(4, 'CTM', 'CUN', { solo_operativa: true }),
        escala(5, 'CUN', 'AZP'),
      ],
    });
    expect(r.escalas.map((e) => e.orden)).toEqual([1, 2]);
    expect(r.ruta).toBe('CUN → CZM → CUN → AZP');
  });

  it('snapshot desfasado: manda el pdf_oculto de la escala VIVA (toggle sin Revisar y pre-27-ago)', () => {
    // Snapshot dice visible, la escala dice oculto → OCULTO.
    const oculta = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [tramo(1, 'CUN', 'CZM'), tramo(2, 'CZM', 'CUN')],
      },
      escalas: [
        escala(1, 'CUN', 'CZM'),
        escala(2, 'CZM', 'CUN', { pdf_oculto: true }),
      ],
    });
    expect(oculta.ruta).toBe('CUN → CZM');
    // Snapshot dice oculto, la escala lo volvió a mostrar → VISIBLE.
    const visible = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'CZM'),
          tramo(2, 'CZM', 'CUN', { pdf_oculto: true }),
        ],
      },
      escalas: [escala(1, 'CUN', 'CZM'), escala(2, 'CZM', 'CUN')],
    });
    expect(visible.ruta).toBe('CUN → CZM → CUN');
  });

  it('el tiempo por tramo del De un vistazo sale de TODOS los tramos, ocultos incluidos (decisión 2-sep: horas y TUAS sin ajuste)', () => {
    const r = escalasVisiblesPdf({
      calculo_snapshot: {
        tramos: [
          tramo(1, 'CUN', 'AZP', {
            tiempo_hr: 3.4,
            millas: 850,
            pdf_oculto: true,
          }),
          tramo(2, 'AZP', 'CZM', { tiempo_hr: 1.2 }),
        ],
      },
      escalas: [],
    });
    expect(r.tiempoTramoSnapMaxHr).toBe(3.4);
    // El fallback por millas usa el mismo criterio (todos los tramos).
    expect(r.millasTramoMaxNm).toBe(850);
  });

  it('rama fallback: las millas para el De un vistazo también salen de TODOS los tramos comerciales (2-sep)', () => {
    const r = escalasVisiblesPdf({
      calculo_snapshot: {},
      escalas: [
        escala(1, 'CUN', 'AZP', { millas_nauticas: 850, pdf_oculto: true }),
        escala(2, 'AZP', 'CUN', { millas_nauticas: 850, pdf_oculto: true }),
        escala(3, 'CUN', 'CZM', { millas_nauticas: 30 }),
        // Operativas/canceladas siguen fuera (no son tramos cotizados).
        escala(4, 'CZM', 'MID', {
          millas_nauticas: 5000,
          solo_operativa: true,
        }),
      ],
    });
    expect(r.millasTramoMaxNm).toBe(850);
    expect(r.ruta).toBe('CUN → CZM');
  });

  describe('fecha del tramo SOLO para el PDF (pdf_fecha, 3-sep)', () => {
    it('sale de la escala VIVA por orden; el oculto no la expone y sobrevive la renumeración', () => {
      const r = escalasVisiblesPdf({
        calculo_snapshot: {
          tramos: [
            tramo(1, 'CUN', 'CZM'),
            tramo(2, 'CZM', 'MID'),
            tramo(3, 'MID', 'CUN'),
          ],
        },
        escalas: [
          escala(1, 'CUN', 'CZM', { pdf_fecha: '2026-09-05' }),
          escala(2, 'CZM', 'MID', {
            pdf_oculto: true,
            pdf_fecha: '2026-09-06',
          }),
          escala(3, 'MID', 'CUN'),
        ],
      });
      // El tramo 3 real se renumera a 2 y conserva SU fecha (null): la
      // fecha no se desplaza con la renumeración.
      expect(r.escalas.map((e) => [e.orden, e.pdf_fecha])).toEqual([
        [1, '2026-09-05'],
        [2, null],
      ]);
      // La fecha del tramo oculto jamás viaja al payload.
      expect(JSON.stringify(r)).not.toContain('2026-09-06');
    });

    it('sin pdf_fecha NO hay fallback a fecha_salida_plan ni a la fecha del vuelo', () => {
      const r = escalasVisiblesPdf({
        fecha_vuelo: '2026-09-01T08:00:00.000Z',
        calculo_snapshot: {
          tramos: [tramo(1, 'CUN', 'CZM'), tramo(2, 'CZM', 'CUN')],
        },
        escalas: [escala(1, 'CUN', 'CZM'), escala(2, 'CZM', 'CUN')],
      });
      expect(r.escalas.map((e) => e.pdf_fecha)).toEqual([null, null]);
      // Sin escalas vivas tampoco inventa nada.
      const sinVivas = escalasVisiblesPdf({
        fecha_vuelo: '2026-09-01T08:00:00.000Z',
        calculo_snapshot: {
          tramos: [tramo(1, 'CUN', 'CZM'), tramo(2, 'CZM', 'CUN')],
        },
        escalas: [],
      });
      expect(sinVivas.escalas.map((e) => e.pdf_fecha)).toEqual([null, null]);
    });

    it('es fecha de PARED: el string viaja tal cual (recortado a YYYY-MM-DD si el driver trae hora)', () => {
      const r = escalasVisiblesPdf({
        calculo_snapshot: { tramos: [tramo(1, 'CUN', 'CZM')] },
        escalas: [
          escala(1, 'CUN', 'CZM', { pdf_fecha: '2026-09-05T00:00:00' }),
        ],
      });
      expect(r.escalas[0].pdf_fecha).toBe('2026-09-05');
    });

    it('rama fallback (sin snapshot.tramos): mismo par — fecha viva, oculto no la expone, sin fallback', () => {
      const r = escalasVisiblesPdf({
        fecha_vuelo: '2026-09-01T08:00:00.000Z',
        calculo_snapshot: {},
        escalas: [
          escala(1, 'CUN', 'CZM', { pdf_fecha: '2026-09-05' }),
          escala(2, 'CZM', 'MID', {
            pdf_oculto: true,
            pdf_fecha: '2026-09-06',
          }),
          escala(3, 'MID', 'CUN'),
        ],
      });
      expect(r.escalas.map((e) => [e.orden, e.pdf_fecha])).toEqual([
        [1, '2026-09-05'],
        [2, null],
      ]);
      expect(JSON.stringify(r)).not.toContain('2026-09-06');
    });
  });
});
