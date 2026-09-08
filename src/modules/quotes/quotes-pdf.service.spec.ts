// QuotesPdfService importa QuotesService (solo para inyección) y ese módulo
// arrastra notifications (gateway + `jose` ESM) y calendar-sync
// (googleapis): mismos stubs que quotes.service.spec.ts.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PreviewQuoteDto } from './dto/preview-quote.dto';
import {
  QuotesPdfService,
  escalasVisiblesPdf,
  type CotizacionPdfPayload,
} from './quotes-pdf.service';
import type { QuotesService } from './quotes.service';

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

// =====================================================================
// Refactor 8-sep-2026: cargarQuoteLike / armarPayloadPdf / renderPdf y la
// vista previa (renderPreviewHtml / previewHtml). El payload del PDF NO
// cambia: se compara contra el "snapshot" de una cotización real simulada
// (misma forma que findById + escalas vivas) tal como lo armaba render().
// =====================================================================

type Row = Record<string, unknown>;

function supabasePdfMock(
  tablas: Record<string, { single?: Row | null; lista?: Row[] }>,
  calls: string[],
): SupabaseService {
  const from = (tabla: string) => {
    calls.push(tabla);
    const t = tablas[tabla] ?? {};
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) {
      b[m] = jest.fn(chain);
    }
    b.maybeSingle = jest.fn(() =>
      Promise.resolve({ data: t.single ?? null, error: null }),
    );
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: t.lista ?? [], error: null }).then(res, rej);
    return b;
  };
  return { service: { from } } as unknown as SupabaseService;
}

const KODIAK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Cotización #148 tal como sale de findById (+ escalas vivas + modelos). */
function quote148(): Row {
  return {
    id: 'v148',
    folio: 148,
    cliente_id: 'c1',
    aeronave_id: KODIAK_ID,
    tipo: 'MULTIESCALA',
    pasajeros: 4,
    es_externo: false,
    avion_externo_modelo: null,
    avion_externo_matricula: null,
    fecha_confirmacion: null,
    fecha_solicitud: '2026-09-01T15:00:00.000Z',
    fecha_vuelo: '2026-09-12T13:00:00.000Z',
    fecha_traslado_final: '2026-09-12T23:00:00.000Z',
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    tiempo_cobrable_hr: 2.4,
    tarifa_hora_usd: 1650,
    pdf_mostrar_tarifa: true,
    pdf_mostrar_itinerario: true,
    subtotal_vuelo_usd: 3960,
    ajuste_final_usd: -50,
    tuas_usd: 100,
    extras: [
      {
        concepto: 'Catering',
        monto_usd: 170,
        moneda: 'USD',
        monto_nativo: 170,
        tc_aplicado: null,
        aplica_iva: true,
        cantidad: 2,
        unitario: 85,
      },
      {
        concepto: 'Handler',
        monto_usd: 54.05,
        moneda: 'MXN',
        monto_nativo: 1000,
        tc_aplicado: 18.5,
        aplica_iva: false,
      },
    ],
    iva_pct: 16,
    iva_usd: 700.8,
    monto_total_usd: 5080.8,
    monto_total_mxn: 91962.48,
    tc_usd_mxn: 18.1,
    notas: 'Sujeto a slot en CUN',
    calculo_snapshot: {
      aeronave: {
        id: KODIAK_ID,
        matricula: 'N621TX',
        modelo: 'Piper Seneca V',
      },
      tramos: [
        {
          orden: 1,
          origen: 'CUN',
          destino: 'HOL',
          millas: 190,
          pasajeros: 4,
          es_ferry: false,
          tiempo_hr: 1.2,
          requiere_pernocta: false,
          pernocta_usd: 0,
          tipo_parada: 'NORMAL',
          servicio_notas: null,
          pdf_oculto: null,
        },
        {
          orden: 2,
          origen: 'HOL',
          destino: 'CZM',
          millas: 60,
          pasajeros: 4,
          es_ferry: false,
          tiempo_hr: 0.55,
          requiere_pernocta: true,
          pernocta_usd: 150,
          tipo_parada: 'NORMAL',
          servicio_notas: null,
          pdf_oculto: null,
        },
        {
          orden: 3,
          origen: 'CZM',
          destino: 'CUN',
          millas: 30,
          pasajeros: 4,
          es_ferry: false,
          tiempo_hr: 0.35,
          requiere_pernocta: false,
          pernocta_usd: 0,
          tipo_parada: 'NORMAL',
          servicio_notas: null,
          pdf_oculto: null,
        },
      ],
      desglose: [
        {
          clave: 'SUBTOTAL_VUELO',
          concepto: 'Servicio aéreo',
          monto_usd: 3960,
        },
        { clave: 'TUAS', concepto: 'TUA CUN · $25.00 × 4 pax', monto_usd: 100 },
        {
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión Itzy',
          monto_usd: 150,
        },
        { clave: 'AJUSTE', concepto: 'Descuento', monto_usd: -50 },
      ],
      totales: { extras_total_usd: 224.05, viaticos_pernocta_usd: 150 },
    },
    escalas: [
      {
        id: 'e1',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'HOL',
        solo_operativa: false,
        cancelada_at: null,
        pdf_oculto: false,
        pdf_fecha: '2026-09-12',
        fecha_salida_plan: '2026-09-12T13:00:00.000Z',
      },
      {
        id: 'e2',
        orden: 2,
        origen_iata: 'HOL',
        destino_iata: 'CZM',
        solo_operativa: false,
        cancelada_at: null,
        // Oculto SOLO en la escala viva (toggle sin Revisar): manda.
        pdf_oculto: true,
        pdf_fecha: '2026-09-12',
        fecha_salida_plan: '2026-09-12T16:00:00.000Z',
      },
      {
        id: 'e3',
        orden: 3,
        origen_iata: 'CZM',
        destino_iata: 'CUN',
        solo_operativa: false,
        cancelada_at: null,
        pdf_oculto: false,
        pdf_fecha: null,
        fecha_salida_plan: '2026-09-12T21:00:00.000Z',
      },
    ],
    modelos_cotizados: ['Piper Seneca V'],
  };
}

/** Payload EXACTO que render() mandaba a pyservices para quote148 (con fotos). */
const PAYLOAD_148 = {
  folio: '148',
  fecha: '2026-09-01T15:00:00.000Z',
  cliente: 'Punta Pájaros SA de CV',
  aeronave_cotizada_modelo: 'Piper Seneca V',
  modelos_cotizados: ['Piper Seneca V'],
  origen: 'CUN',
  destino: 'CUN',
  tipo: 'MULTIESCALA',
  pasajeros: 4,
  fecha_traslado_inicial: '2026-09-12T13:00:00.000Z',
  fecha_traslado_final: '2026-09-12T23:00:00.000Z',
  ruta: 'CUN → HOL → CZM → CUN',
  escalas: [
    {
      orden: 1,
      origen: 'CUN',
      destino: 'HOL',
      pasajeros: 4,
      es_ferry: false,
      requiere_pernocta: false,
      pernocta_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
      fecha: '2026-09-12',
    },
    {
      // El tramo 3 real se renumera a 2 y conserva SU fecha (null).
      orden: 2,
      origen: 'CZM',
      destino: 'CUN',
      pasajeros: 4,
      es_ferry: false,
      requiere_pernocta: false,
      pernocta_usd: 0,
      tipo_parada: 'NORMAL',
      servicio_notas: null,
      fecha: null,
    },
  ],
  tiempo_cobrable_hr: 2.4,
  tarifa_hora_usd: 1650,
  mostrar_tarifa_hora: true,
  mostrar_itinerario: true,
  // 3960 + comisión 150 (absorbida); el descuento NO se absorbe (va aparte).
  subtotal_usd: 4110,
  tuas_usd: 100,
  tuas_detalle: ['TUA CUN · $25.00 × 4 pax'],
  extras: [
    {
      concepto: 'Catering',
      monto_usd: 170,
      moneda: 'USD',
      monto_nativo: 170,
      aplica_iva: true,
      cantidad: 2,
      unitario: 85,
    },
    {
      concepto: 'Handler',
      monto_usd: 54.05,
      moneda: 'MXN',
      monto_nativo: 1000,
      aplica_iva: false,
    },
  ],
  extras_total_usd: 224.05,
  viaticos_pernocta_usd: 150,
  descuento_usd: 50,
  iva_pct: 16,
  iva_usd: 700.8,
  total_usd: 5080.8,
  total_mxn: 91962.48,
  tc_usd_mxn: 18.1,
  moneda: 'USD',
  notas: 'Sujeto a slot en CUN',
  matricula: 'N621TX',
  avion_externo: null,
  foto_exterior: 'data:image/jpeg;base64,AQID',
  foto_interior: 'data:image/png;base64,AQID',
  avion_modelo: 'Piper Seneca V',
  avion_velocidad_kts: 165,
  avion_pasajeros: 6,
  avion_num_motores: 2,
  avion_motor_hp: 220,
  avion_caracteristicas: ['Presurizado'],
  // Tramo más largo de TODOS los cotizados (el oculto incluido): 1.2 h.
  avion_tiempo_tramo_hr: 1.2,
  mapa_puntos: [
    {
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'HOL',
      o_lat: 21.04,
      o_lon: -86.87,
      d_lat: 20.63,
      d_lon: -87.1,
      es_ferry: false,
    },
    {
      orden: 2,
      origen_iata: 'CZM',
      destino_iata: 'CUN',
      o_lat: 20.52,
      o_lon: -86.93,
      d_lat: 21.04,
      d_lon: -86.87,
      es_ferry: false,
    },
  ],
};

function tablas148() {
  return {
    cliente: {
      single: {
        nombre: 'Punta Pájaros',
        razon_social_default: 'Punta Pájaros SA de CV',
      },
    },
    aeronave: {
      single: {
        matricula: 'N621TX',
        modelo: 'Piper Seneca V',
        velocidad_crucero_kts: 165,
        asientos: 6,
        num_motores: 2,
        motor_hp: 220,
        caracteristicas: ['Presurizado'],
      },
    },
    aeronave_imagen: {
      lista: [
        {
          url: 'https://cdn/ext.jpg',
          etiqueta: 'EXTERIOR',
          content_type: 'image/jpeg',
        },
        {
          url: 'https://cdn/int.png',
          etiqueta: 'INTERIOR',
          content_type: 'image/png',
        },
      ],
    },
    aeropuerto: {
      lista: [
        { iata: 'CUN', latitud: 21.04, longitud: -86.87 },
        { iata: 'HOL', latitud: 20.63, longitud: -87.1 },
        { iata: 'CZM', latitud: 20.52, longitud: -86.93 },
      ],
    },
  };
}

function pdfService(
  calls: string[],
  deps: {
    quotes?: Partial<QuotesService>;
    pyservices?: Partial<PyservicesService>;
  } = {},
) {
  const config = {
    get: (k: string) => (k === 'PYSERVICES_BASE_URL' ? 'http://py/' : 'tok'),
  } as unknown as ConfigService<EnvVars, true>;
  const svc = new QuotesPdfService(
    config,
    supabasePdfMock(tablas148(), calls),
    (deps.quotes ?? {}) as QuotesService,
    (deps.pyservices ?? {}) as PyservicesService,
  );
  return svc;
}

describe('QuotesPdfService — armarPayloadPdf / render / vista previa', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      } as unknown as Response),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it('payload del PDF byte-idéntico al de render() antes del refactor (cotización #148 simulada)', async () => {
    const calls: string[] = [];
    const payload = await pdfService(calls).armarPayloadPdf(quote148(), {
      conFotos: true,
    });
    expect(payload).toEqual(PAYLOAD_148);
    expect(calls).toEqual([
      'cliente',
      'aeronave',
      'aeronave_imagen',
      'aeropuerto',
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('conFotos:false: no consulta la galería ni descarga; SOLO difieren foto_exterior/foto_interior (null)', async () => {
    const calls: string[] = [];
    const payload = await pdfService(calls).armarPayloadPdf(quote148(), {
      conFotos: false,
    });
    expect(payload).toEqual({
      ...PAYLOAD_148,
      foto_exterior: null,
      foto_interior: null,
    });
    expect(calls).toEqual(['cliente', 'aeronave', 'aeropuerto']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('iva_pct como fracción (0.16) se normaliza a 16', async () => {
    const payload = await pdfService([]).armarPayloadPdf(
      { ...quote148(), iva_pct: 0.16 },
      { conFotos: false },
    );
    expect(payload.iva_pct).toBeCloseTo(16, 10);
  });

  it('render() = armarPayloadPdf(conFotos) → renderPdf; renderPreviewHtml() = armarPayloadPdf(sin fotos) → pyservices preview-html', async () => {
    const preview = jest.fn().mockResolvedValue('<html>hoja 1</html>');
    const svc = pdfService([], {
      pyservices: { generateCotizacionPreviewHtml: preview },
    });
    const renderPdf = jest
      .spyOn(svc, 'renderPdf')
      .mockResolvedValue(Buffer.from('pdf'));
    await expect(svc.render(quote148())).resolves.toEqual(Buffer.from('pdf'));
    expect(renderPdf).toHaveBeenCalledWith(PAYLOAD_148);

    await expect(svc.renderPreviewHtml(quote148())).resolves.toBe(
      '<html>hoja 1</html>',
    );
    expect(preview).toHaveBeenCalledWith({
      ...PAYLOAD_148,
      foto_exterior: null,
      foto_interior: null,
    });
  });

  it('previewHtml(dto): el quote-like lo arma QuotesService.quoteLikeParaPreview (limpia = misma fila que el PDF)', async () => {
    const quoteLikeParaPreview = jest.fn().mockResolvedValue(quote148());
    const preview = jest.fn().mockResolvedValue('<html/>');
    const svc = pdfService([], {
      quotes: { quoteLikeParaPreview },
      pyservices: { generateCotizacionPreviewHtml: preview },
    });
    const dto = { quote_id: 'v148', sucio: false } as PreviewQuoteDto;
    await expect(svc.previewHtml(dto)).resolves.toBe('<html/>');
    expect(quoteLikeParaPreview).toHaveBeenCalledWith(dto);
    expect(preview).toHaveBeenCalledWith({
      ...PAYLOAD_148,
      foto_exterior: null,
      foto_interior: null,
    });
  });

  it('renderPdf(): POST /reportes/cotizacion con X-Internal-Token y devuelve el PDF', async () => {
    const svc = pdfService([]);
    const buf = await svc.renderPdf(
      PAYLOAD_148 as unknown as CotizacionPdfPayload,
    );
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://py/reportes/cotizacion');
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe(
      'tok',
    );
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD_148);
  });
});
