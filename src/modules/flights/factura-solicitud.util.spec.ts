import {
  bloqueFacturaServicio,
  cobrosAntesDelCambio,
  cobrosAsignables,
  miniDeFactura,
  resumenCobrosDeFactura,
  elegirDestinatarios,
  esMarcadoSinRegistro,
  esPorFacturar,
  esSolicitudAutomatica,
  esSolicitudYaNoAplica,
  estadoSolicitud,
  fechaDiaMes,
  LIMITE_NOTA_SOLICITUD,
  linkAvisoCambioSolicitud,
  notaSolicitudAutomatica,
  PREFIJO_NOTA_SOLICITUD_AUTOMATICA,
  resumenFacturaServicio,
  solicitudYaNoAplica,
  textoAvisoCambioSolicitud,
  textoAvisoEmitida,
  textoAvisoSolicitud,
  TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR,
  TIPO_AVISO_SOLICITUD_YA_NO_APLICA,
  transicionSolicitudAutomatica,
  type CobroParaFactura,
  type FacturaLigadaRow,
} from './factura-solicitud.util';

/**
 * «Necesito factura» (pedido de Itzi, 24-sep-2026): «por facturar» es
 * DERIVADO con UNA definición, los destinatarios se eligen por nivel y los
 * textos del aviso no dicen «Total $0 USD».
 */
const SOLICITADA = {
  estado: 'CONFIRMADO',
  facturado: false,
  factura_solicitada_at: '2026-09-24T15:00:00Z',
  factura_solicitada_por: 'u-itzi',
  factura_solicitud_nota: 'Lo necesita para pagar',
  factura_paga_contra_factura: true,
};

const ligada = (
  id: string,
  estatus: string,
  extra: Partial<FacturaLigadaRow> = {},
): FacturaLigadaRow => ({
  id,
  serie: 'A',
  folio: id,
  folio_num: Number(id),
  uuid: null,
  fecha_emision: '2026-09-24',
  estatus,
  total: '8050.40',
  moneda: 'USD',
  metodo_pago: 'PPD',
  pdf_path: `emitidas/${id}/x.pdf`,
  xml_path: null,
  deleted_at: null,
  ...extra,
});

describe('esPorFacturar (definición ÚNICA §3.8)', () => {
  it('solicitada, no cancelado, sin CFDI y sin vigentes ⇒ por facturar', () => {
    expect(esPorFacturar(SOLICITADA, 0, null)).toBe(true);
  });
  it('una vigente ligada lo saca', () => {
    expect(esPorFacturar(SOLICITADA, 1, null)).toBe(false);
  });
  it('CANCELADO, CFDI del PAC o sin solicitud ⇒ no', () => {
    expect(esPorFacturar({ ...SOLICITADA, estado: 'CANCELADO' }, 0, null)).toBe(
      false,
    );
    expect(esPorFacturar({ ...SOLICITADA, facturado: true }, 0, null)).toBe(
      false,
    );
    expect(
      esPorFacturar({ ...SOLICITADA, factura_solicitada_at: null }, 0, null),
    ).toBe(false);
    expect(esPorFacturar(null, 0, null)).toBe(false);
  });

  // Caso #376 (13-oct-2026, invariante 65): el estatus MANUAL «Facturado»
  // saca al vuelo de la bandeja y lo manda a la nota «marcados sin registro».
  it('FACTURADO a mano sin vigentes ⇒ MARCADO_SIN_REGISTRO (fuera de «por facturar»)', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud(v, 0, null)).toBe('MARCADO_SIN_REGISTRO');
    expect(esPorFacturar(v, 0, null)).toBe(false);
    expect(esMarcadoSinRegistro(v, 0, null)).toBe(true);
  });
  it('FACTURADO a mano CON una vigente ⇒ NINGUNO (ya está registrada)', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud(v, 1, null)).toBe('NINGUNO');
    expect(esPorFacturar(v, 1, null)).toBe(false);
    expect(esMarcadoSinRegistro(v, 1, null)).toBe(false);
  });
  it('ELABORADA_ENVIADA, SIN_FACTURA y sin la llave ⇒ POR_FACTURAR (como antes)', () => {
    for (const v of [
      { ...SOLICITADA, factura_estatus: 'ELABORADA_ENVIADA' },
      { ...SOLICITADA, factura_estatus: 'SIN_FACTURA' },
      { ...SOLICITADA, factura_estatus: null },
      SOLICITADA,
    ]) {
      expect(estadoSolicitud(v, 0, null)).toBe('POR_FACTURAR');
      expect(esPorFacturar(v, 0, null)).toBe(true);
      expect(esMarcadoSinRegistro(v, 0, null)).toBe(false);
    }
  });
  it('FACTURADO + CANCELADO, CFDI del PAC o sin solicitud ⇒ NINGUNO', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud({ ...v, estado: 'CANCELADO' }, 0, null)).toBe(
      'NINGUNO',
    );
    expect(estadoSolicitud({ ...v, facturado: true }, 0, null)).toBe('NINGUNO');
    expect(
      estadoSolicitud({ ...v, factura_solicitada_at: null }, 0, null),
    ).toBe('NINGUNO');
    expect(estadoSolicitud(null, 0, null)).toBe('NINGUNO');
  });
});

describe('bloque y resumen', () => {
  it('bloque: solicitud con nombre, vigentes ordenadas, canceladas contadas, borradas fuera', () => {
    const b = bloqueFacturaServicio(
      SOLICITADA,
      [
        ligada('130', 'VIGENTE'),
        ligada('123', 'VIGENTE'),
        ligada('99', 'CANCELADA'),
        ligada('50', 'VIGENTE', { deleted_at: '2026-09-24T00:00:00Z' }),
      ],
      'Itzi',
      null,
    );
    expect(b.solicitud).toEqual({
      solicitada_at: '2026-09-24T15:00:00Z',
      solicitada_por: { id: 'u-itzi', nombre: 'Itzi' },
      nota: 'Lo necesita para pagar',
      paga_contra_factura: true,
    });
    expect(b.por_facturar).toBe(false);
    expect(b.facturas.map((f) => f.etiqueta)).toEqual(['A-123', 'A-130']);
    expect(b.facturas[0]).toMatchObject({
      total: 8050.4,
      moneda: 'USD',
      metodo_pago: 'PPD',
      tiene_pdf: true,
      tiene_xml: false,
    });
    expect(b.canceladas).toBe(1);
    expect(b.marcado_sin_registro).toBe(false);
  });

  it('bloque: FACTURADO a mano con solo canceladas ⇒ marcado_sin_registro (y no por_facturar)', () => {
    const b = bloqueFacturaServicio(
      { ...SOLICITADA, factura_estatus: 'FACTURADO' },
      [ligada('99', 'CANCELADA')],
      'Itzi',
      null,
    );
    expect(b.por_facturar).toBe(false);
    expect(b.marcado_sin_registro).toBe(true);
    expect(b.solicitud?.solicitada_por).toEqual({
      id: 'u-itzi',
      nombre: 'Itzi',
    });
    // Con la factura ya registrada, ninguna de las dos.
    const conVigente = bloqueFacturaServicio(
      { ...SOLICITADA, factura_estatus: 'FACTURADO' },
      [ligada('440', 'VIGENTE')],
      undefined,
      null,
    );
    expect(conVigente.por_facturar).toBe(false);
    expect(conVigente.marcado_sin_registro).toBe(false);
  });

  it('resumen de la lista', () => {
    expect(
      resumenFacturaServicio(SOLICITADA, [ligada('1', 'CANCELADA')], null),
    ).toEqual({
      solicitada: true,
      por_facturar: true,
      paga_contra_factura: true,
      facturas: 0,
    });
    expect(resumenFacturaServicio({ estado: 'CONFIRMADO' }, [], null)).toEqual({
      solicitada: false,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
    // FACTURADO a mano: sigue «solicitada», ya no «por facturar» (el chip
    // ámbar de las listas desaparece; la forma del resumen no cambia).
    expect(
      resumenFacturaServicio(
        { ...SOLICITADA, factura_estatus: 'FACTURADO' },
        [],
        null,
      ),
    ).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: true,
      facturas: 0,
    });
  });
});

describe('elegirDestinatarios (nivel ANTES de excluir)', () => {
  const mary = { id: 'u-mary', nombre: 'Mary Cruz' };
  const ale = { id: 'u-ale', nombre: 'Alejandro' };
  const fact = { id: 'u-fact', nombre: 'Facturista' };

  it('config manda', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-itzi',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [mary] });
  });
  it('sin config ⇒ rol FACTURACION; sin él ⇒ ADMIN (menos quien pidió)', () => {
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [fact], admins: [ale] },
        null,
      ),
    ).toEqual({ fuente: 'ROL_FACTURACION', destinatarios: [fact] });
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [], admins: [ale, mary] },
        'u-ale',
      ),
    ).toEqual({ fuente: 'ADMINS', destinatarios: [mary] });
  });
  it('si quien pide ES el único del nivel, nadie recibe aviso (no baja de nivel)', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-mary',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [] });
  });
});

describe('textos de los avisos (§5)', () => {
  it('fechaDiaMes en hora Cancún sin día de la semana', () => {
    // 27 sep 04:00 UTC = 26 sep 23:00 Cancún.
    expect(fechaDiaMes('2026-09-27T04:00:00Z')).toBe('26 sep');
    expect(fechaDiaMes(null)).toBe('');
  });

  it('solicitud de un vuelo con total, paga contra factura y nota', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          {
            folio: 341,
            fecha_vuelo: '2026-09-27T14:00:00Z',
            monto_total_usd: '8050.4',
          },
        ],
        cliente: 'Maqar',
        pagaContraFactura: true,
        nota: 'Mandó datos por correo',
      }),
    ).toEqual({
      titulo: 'Factura pedida: vuelo #341',
      cuerpo:
        'Itzi pidió factura del vuelo #341 · Maqar · 27 sep · Total $8,050.40 USD. El cliente paga hasta recibir la factura. Nota: Mandó datos por correo',
    });
  });

  it('sin precio ni fecha se omiten (nunca «Total $0 USD»)', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [{ folio: 12, fecha_vuelo: null, monto_total_usd: 0 }],
        cliente: null,
      }).cuerpo,
    ).toBe('Itzi pidió factura del vuelo #12.');
  });

  it('grupo: una sola notificación con todos los folios', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          { folio: 343, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 342, fecha_vuelo: '2026-09-27T14:00:00Z' },
        ],
        cliente: 'Maqar',
        grupoFolio: 12,
      }),
    ).toEqual({
      titulo: 'Factura pedida: grupo G-12',
      cuerpo:
        'Itzi pidió factura de los vuelos #341, #342 y #343 (grupo G-12) · Maqar · 27 sep.',
    });
  });

  it('factura emitida a quien la pidió', () => {
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [341],
        cliente: 'Maqar',
      }),
    ).toEqual({
      titulo: 'Ya está la factura A-123',
      cuerpo: 'Mary Cruz registró la factura A-123 del vuelo #341 · Maqar.',
    });
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [342, 341],
        cliente: 'Maqar',
      }).cuerpo,
    ).toBe(
      'Mary Cruz registró la factura A-123 de los vuelos #341 y #342 · Maqar.',
    );
  });
});

describe('solicitud AUTOMÁTICA por un cobro que exige factura (13-oct-2026, invariante 60)', () => {
  const vuelo341 = {
    folio: 341,
    fecha_vuelo: '2026-09-27T14:00:00Z',
    monto_total_usd: '8050.4',
  };

  it('sin `automatica` la salida es byte a byte la de siempre', () => {
    const base = {
      actor: 'Itzi',
      vuelos: [vuelo341],
      cliente: 'Maqar',
      pagaContraFactura: true,
      nota: 'Mandó datos por correo',
    };
    expect(textoAvisoSolicitud({ ...base, automatica: undefined })).toEqual(
      textoAvisoSolicitud(base),
    );
    expect(textoAvisoSolicitud(base).titulo).toBe('Factura pedida: vuelo #341');
  });

  it('vuelo con cliente, fecha y total: título y cuerpo exactos; nunca «Nota:» ni «paga contra factura»', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [vuelo341],
        cliente: 'Maqar',
        pagaContraFactura: true,
        nota: 'Mandó datos por correo',
        automatica: { origen: 'en HSBC Pesos' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelo #341',
      cuerpo:
        'Cobro en HSBC Pesos registrado por Itzi: el vuelo #341 necesita factura · Maqar · 27 sep · Total $8,050.40 USD.',
    });
  });

  it('sin fecha ni total se omiten los tramos; sin cuenta el origen es «por Transferencia»', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Alguien de la oficina',
        vuelos: [{ folio: 12, fecha_vuelo: null, monto_total_usd: 0 }],
        cliente: null,
        automatica: { origen: 'por Transferencia' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelo #12',
      cuerpo:
        'Cobro por Transferencia registrado por Alguien de la oficina: el vuelo #12 necesita factura.',
    });
  });

  it('grupo con folio G-12 y grupo sin folio', () => {
    const vuelos = [
      { folio: 343, fecha_vuelo: '2026-09-27T14:00:00Z' },
      { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' },
      { folio: 342, fecha_vuelo: '2026-09-27T14:00:00Z' },
    ];
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos,
        cliente: 'Maqar',
        grupoFolio: 12,
        automatica: { origen: 'en HSBC Pesos' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: grupo G-12',
      cuerpo:
        'Cobro en HSBC Pesos registrado por Itzi: los vuelos #341, #342 y #343 (grupo G-12) necesitan factura · Maqar · 27 sep.',
    });
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos,
        cliente: 'Maqar',
        grupoFolio: null,
        automatica: { origen: 'por Cheque' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelos #341, #342 y #343',
      cuerpo:
        'Cobro por Cheque registrado por Itzi: los vuelos #341, #342 y #343 necesitan factura · Maqar · 27 sep.',
    });
  });

  it('notaSolicitudAutomatica: prefijo + origen, recortada al tope del CHECK', () => {
    expect(notaSolicitudAutomatica('en HSBC Pesos')).toBe(
      'Solicitada automáticamente: cobro en HSBC Pesos',
    );
    expect(notaSolicitudAutomatica('por Transferencia')).toBe(
      'Solicitada automáticamente: cobro por Transferencia',
    );
    const larga = notaSolicitudAutomatica('x'.repeat(600));
    expect(larga).toHaveLength(LIMITE_NOTA_SOLICITUD);
    expect(larga.startsWith(PREFIJO_NOTA_SOLICITUD_AUTOMATICA)).toBe(true);
  });
});

/**
 * ANTICIPO DEVUELTO — solicitud AUTOMÁTICA que YA NO APLICA (14-oct-2026,
 * API 0.0.77, invariante 60): estado derivado (sin escribir `vuelo`), 3.er
 * parámetro OBLIGATORIO de `estadoSolicitud` (F8), llaves del bloque y los
 * avisos de TRANSICIÓN (F14) con su contrafactual.
 */
describe('solicitud AUTOMÁTICA que ya no aplica (14-oct-2026, API 0.0.77)', () => {
  const AUTOMATICA = {
    ...SOLICITADA,
    factura_solicitud_nota: 'Solicitada automáticamente: cobro en HSBC Pesos',
    factura_paga_contra_factura: false,
  };

  it('esSolicitudAutomatica: pedida y con el prefijo EXACTO; nota editada o sin solicitud ⇒ false', () => {
    expect(esSolicitudAutomatica(AUTOMATICA)).toBe(true);
    expect(esSolicitudAutomatica(SOLICITADA)).toBe(false);
    expect(
      esSolicitudAutomatica({
        ...AUTOMATICA,
        factura_solicitud_nota: 'Ya con datos fiscales (editada por Itzi)',
      }),
    ).toBe(false);
    expect(
      esSolicitudAutomatica({
        ...AUTOMATICA,
        factura_solicitud_nota:
          ' Solicitada automáticamente: cobro en HSBC Pesos',
      }),
    ).toBe(false);
    expect(
      esSolicitudAutomatica({ ...AUTOMATICA, factura_solicitada_at: null }),
    ).toBe(false);
    expect(esSolicitudAutomatica(null)).toBe(false);
    // No mira el estado del vuelo.
    expect(esSolicitudAutomatica({ ...AUTOMATICA, estado: 'CANCELADO' })).toBe(
      true,
    );
  });

  it('solicitudYaNoAplica: automática + exigencia leída ≠ EXIGE; manual nunca; null = no leída', () => {
    expect(solicitudYaNoAplica(AUTOMATICA, 'NO_EXIGE')).toBe(true);
    expect(solicitudYaNoAplica(AUTOMATICA, 'SIN_COBROS')).toBe(true);
    expect(solicitudYaNoAplica(AUTOMATICA, 'EXIGE')).toBe(false);
    expect(solicitudYaNoAplica(AUTOMATICA, null)).toBe(false);
    expect(solicitudYaNoAplica(SOLICITADA, 'NO_EXIGE')).toBe(false);
    expect(
      solicitudYaNoAplica({ ...AUTOMATICA, estado: 'CANCELADO' }, 'NO_EXIGE'),
    ).toBe(true);
  });

  it('estadoSolicitud con 3 parámetros: YA_NO_APLICA, la manual sigue, null = como antes, FACTURADO gana, CANCELADO ⇒ NINGUNO', () => {
    expect(estadoSolicitud(AUTOMATICA, 0, 'NO_EXIGE')).toBe('YA_NO_APLICA');
    expect(estadoSolicitud(AUTOMATICA, 0, 'SIN_COBROS')).toBe('YA_NO_APLICA');
    expect(estadoSolicitud(AUTOMATICA, 0, 'EXIGE')).toBe('POR_FACTURAR');
    expect(estadoSolicitud(AUTOMATICA, 0, null)).toBe('POR_FACTURAR');
    expect(estadoSolicitud(SOLICITADA, 0, 'NO_EXIGE')).toBe('POR_FACTURAR');
    expect(
      estadoSolicitud(
        { ...AUTOMATICA, factura_estatus: 'FACTURADO' },
        0,
        'NO_EXIGE',
      ),
    ).toBe('MARCADO_SIN_REGISTRO');
    expect(
      estadoSolicitud({ ...AUTOMATICA, estado: 'CANCELADO' }, 0, 'NO_EXIGE'),
    ).toBe('NINGUNO');
    expect(estadoSolicitud(AUTOMATICA, 1, 'NO_EXIGE')).toBe('NINGUNO');
    expect(esSolicitudYaNoAplica(AUTOMATICA, 0, 'NO_EXIGE')).toBe(true);
    expect(esPorFacturar(AUTOMATICA, 0, 'NO_EXIGE')).toBe(false);
    expect(esMarcadoSinRegistro(AUTOMATICA, 0, 'NO_EXIGE')).toBe(false);
  });

  it('bloque: las 3 llaves nuevas AL FINAL y en orden; sin factura leída ⇒ null / [] / false', () => {
    const b = bloqueFacturaServicio(AUTOMATICA, [], 'Itzi', {
      exigencia: 'NO_EXIGE',
      origenes_exigen: [],
    });
    expect(Object.keys(b)).toEqual([
      'solicitud',
      'por_facturar',
      'facturas',
      'canceladas',
      'marcado_sin_registro',
      'exigencia',
      'origenes_exigen',
      'solicitud_ya_no_aplica',
      // Facturas por cobro (16-oct-2026, invariante 84), últimas y en orden.
      'cobros_sin_factura',
      'cobros_sin_factura_exigen',
      'asignacion_disponible',
    ]);
    expect(b).toMatchObject({
      por_facturar: false,
      exigencia: 'NO_EXIGE',
      origenes_exigen: [],
      solicitud_ya_no_aplica: true,
    });
    const exige = bloqueFacturaServicio(SOLICITADA, [], 'Itzi', {
      exigencia: 'EXIGE',
      origenes_exigen: ['en HSBC Pesos'],
    });
    expect(exige).toMatchObject({
      por_facturar: true,
      exigencia: 'EXIGE',
      origenes_exigen: ['en HSBC Pesos'],
      solicitud_ya_no_aplica: false,
    });
    const sinLeer = bloqueFacturaServicio(AUTOMATICA, [], null, null);
    expect(sinLeer).toMatchObject({
      por_facturar: true,
      exigencia: null,
      origenes_exigen: [],
      solicitud_ya_no_aplica: false,
    });
    // En un cancelado el chip gris también sale (no mira el estado).
    expect(
      bloqueFacturaServicio({ ...AUTOMATICA, estado: 'CANCELADO' }, [], null, {
        exigencia: 'NO_EXIGE',
        origenes_exigen: [],
      }).solicitud_ya_no_aplica,
    ).toBe(true);
  });

  it('resumen: la automática que ya no aplica no es por_facturar (forma sin cambio)', () => {
    expect(resumenFacturaServicio(AUTOMATICA, [], 'NO_EXIGE')).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
    expect(resumenFacturaServicio(AUTOMATICA, [], null).por_facturar).toBe(
      true,
    );
  });

  const C = (
    id: string,
    monto: number,
    extra: Partial<CobroParaFactura> = {},
  ): CobroParaFactura => ({
    id,
    monto,
    moneda: 'MXN',
    cuenta_destino: 'HSBC Pesos',
    metodo_cobro: 'TRANSFERENCIA',
    tc_usd_mxn: 17.3,
    ...extra,
  });

  it('cobrosAntesDelCambio: ALTA sin la fila nueva; BAJA + la borrada; CAMBIO con los valores de ANTES', () => {
    const despues = [
      C('a', 30000),
      C('r', -30000, { cuenta_destino: null, metodo_cobro: 'EFECTIVO' }),
    ];
    expect(
      cobrosAntesDelCambio(despues, { tipo: 'ALTA', cobroId: 'r' }),
    ).toEqual([C('a', 30000)]);
    const borrada = C('x', 500, { moneda: 'USD', tc_usd_mxn: null });
    expect(
      cobrosAntesDelCambio(despues, { tipo: 'BAJA', fila: borrada }),
    ).toEqual([...despues, borrada]);
    const antes = cobrosAntesDelCambio(
      [C('a', 30000, { cuenta_destino: 'Paywise', metodo_cobro: 'PAYWISE' })],
      {
        tipo: 'CAMBIO',
        cobroId: 'a',
        // Solo los campos de dinero presentes en ANTES (vuelo_id y demás no).
        antes: {
          id: 'a',
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
          monto: 30000,
        },
      },
    );
    expect(antes).toEqual([C('a', 30000)]);
    // Si la fila ya no está, entra la de ANTES.
    expect(
      cobrosAntesDelCambio([], {
        tipo: 'CAMBIO',
        cobroId: 'a',
        antes: C('a', 100),
      }),
    ).toEqual([C('a', 100)]);
  });

  it('transicionSolicitudAutomatica: las 4 combinaciones (se avisa la TRANSICIÓN, no el estado)', () => {
    expect(transicionSolicitudAutomatica('EXIGE', 'NO_EXIGE')).toBe(
      'YA_NO_APLICA',
    );
    expect(transicionSolicitudAutomatica('EXIGE', 'SIN_COBROS')).toBe(
      'YA_NO_APLICA',
    );
    expect(transicionSolicitudAutomatica('NO_EXIGE', 'EXIGE')).toBe(
      'VUELVE_A_APLICAR',
    );
    expect(transicionSolicitudAutomatica('SIN_COBROS', 'EXIGE')).toBe(
      'VUELVE_A_APLICAR',
    );
    expect(transicionSolicitudAutomatica('EXIGE', 'EXIGE')).toBeNull();
    expect(transicionSolicitudAutomatica('NO_EXIGE', 'NO_EXIGE')).toBeNull();
    expect(transicionSolicitudAutomatica('NO_EXIGE', 'SIN_COBROS')).toBeNull();
  });

  it('tipos (≤ 60 caracteres) y link a la tarjeta de la bandeja', () => {
    expect(TIPO_AVISO_SOLICITUD_YA_NO_APLICA).toBe(
      'factura_solicitud_ya_no_aplica',
    );
    expect(TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR).toBe(
      'factura_solicitud_vuelve_a_aplicar',
    );
    expect(TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR.length).toBeLessThanOrEqual(
      60,
    );
    expect(linkAvisoCambioSolicitud('v-341', 'YA_NO_APLICA')).toBe(
      '/admin/flights/v-341#cobros',
    );
    expect(linkAvisoCambioSolicitud('v-341', 'VUELVE_A_APLICAR')).toBe(
      '/admin/facturas-emitidas?resaltar=v-341#por-facturar',
    );
  });

  it('textos LITERALES de los avisos (tramos vacíos se omiten)', () => {
    const vuelo = { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' };
    const t = (
      transicion: 'YA_NO_APLICA' | 'VUELVE_A_APLICAR',
      motivo:
        | 'COBRO_NUEVO'
        | 'REEMBOLSO'
        | 'COBRO_CORREGIDO'
        | 'COBRO_ELIMINADO',
      extra: { origen?: string; eraReembolso?: boolean } = {},
    ) =>
      textoAvisoCambioSolicitud({
        transicion,
        motivo,
        vuelo,
        cliente: 'Maqar',
        ...extra,
      });
    expect(t('YA_NO_APLICA', 'REEMBOLSO')).toEqual({
      titulo: 'Ya no aplica: factura del vuelo #341',
      cuerpo:
        'Se registró la devolución del dinero del vuelo #341 · Maqar · 27 sep: un anticipo devuelto no lleva factura. Su solicitud automática salió de «Por facturar»; retírala desde el detalle del vuelo (botón «Retirar»).',
    });
    expect(t('YA_NO_APLICA', 'COBRO_CORREGIDO').cuerpo).toBe(
      'Se corrigió un cobro del vuelo #341 · Maqar · 27 sep: ya no quedó dinero en una cuenta que exija factura. Su solicitud automática salió de «Por facturar»; retírala desde el detalle del vuelo (botón «Retirar»).',
    );
    expect(t('YA_NO_APLICA', 'COBRO_ELIMINADO').cuerpo).toBe(
      'Se eliminó un cobro del vuelo #341 · Maqar · 27 sep: ya no quedó dinero en una cuenta que exija factura. Su solicitud automática salió de «Por facturar»; retírala desde el detalle del vuelo (botón «Retirar»).',
    );
    expect(
      t('VUELVE_A_APLICAR', 'COBRO_NUEVO', { origen: 'en HSBC Pesos' }),
    ).toEqual({
      titulo: 'Vuelve a aplicar: factura del vuelo #341',
      cuerpo:
        'Entró dinero al vuelo #341 · Maqar · 27 sep (cobro en HSBC Pesos) y quedó en una cuenta que exige factura: su solicitud automática regresó a «Por facturar».',
    });
    expect(t('VUELVE_A_APLICAR', 'COBRO_CORREGIDO').cuerpo).toBe(
      'Se corrigió un cobro del vuelo #341 · Maqar · 27 sep: quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».',
    );
    expect(
      t('VUELVE_A_APLICAR', 'COBRO_ELIMINADO', { eraReembolso: true }).cuerpo,
    ).toBe(
      'Se eliminó un reembolso del vuelo #341 · Maqar · 27 sep: quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».',
    );
    expect(t('VUELVE_A_APLICAR', 'COBRO_ELIMINADO').cuerpo).toBe(
      'Se eliminó un cobro del vuelo #341 · Maqar · 27 sep: quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».',
    );
    expect(t('VUELVE_A_APLICAR', 'REEMBOLSO').cuerpo).toBe(
      'Se registró un reembolso del vuelo #341 · Maqar · 27 sep: quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».',
    );
    // Sin cliente, sin fecha y sin origen: los tramos se omiten.
    expect(
      textoAvisoCambioSolicitud({
        transicion: 'VUELVE_A_APLICAR',
        motivo: 'COBRO_NUEVO',
        vuelo: { folio: 12, fecha_vuelo: null },
        cliente: null,
        origen: null,
      }).cuerpo,
    ).toBe(
      'Entró dinero al vuelo #12 y quedó en una cuenta que exige factura: su solicitud automática regresó a «Por facturar».',
    );
  });
});

describe('facturas por cobro — mini y bloque (16-oct-2026, invariante 84)', () => {
  const c = (
    id: string,
    monto: number,
    factura: string | null,
    extra: Partial<CobroParaFactura> = {},
  ): CobroParaFactura => ({
    id,
    monto,
    moneda: 'MXN',
    cuenta_destino: 'Scotiabank Pesos',
    metodo_cobro: 'TRANSFERENCIA',
    cobro_grupo_id: null,
    factura_emitida_id: factura,
    ...extra,
  });
  // #332: A-0420 (68,208 MXN) ampara el cobro de 68,208; 3 quedan sin factura.
  const cobros332 = [
    c('c1', 68208, '0420'),
    c('c2', 977.45, null),
    c('c3', 1700, null),
    c('c4', 1700, null),
    c('r', -100, null),
    c('s', 500, null, { cobro_grupo_id: 'sobre' }),
  ];

  it('miniDeFactura: es_parcial, cobros_n y cobros_monto (Σ por moneda, USD y luego MXN) al FINAL y en orden; sin cobros ⇒ 0 / []', () => {
    const m = miniDeFactura(
      ligada('0420', 'VIGENTE', {
        moneda: 'MXN',
        total: '68208.00',
        es_parcial: true,
      }),
      cobros332,
    );
    expect(Object.keys(m).slice(-3)).toEqual([
      'es_parcial',
      'cobros_n',
      'cobros_monto',
    ]);
    expect(m).toMatchObject({
      es_parcial: true,
      cobros_n: 1,
      cobros_monto: [{ moneda: 'MXN', monto: 68208 }],
    });
    const mixta = miniDeFactura(ligada('0423', 'VIGENTE'), [
      c('u', 600, '0423', { moneda: 'USD' }),
      c('m', 860.47, '0423'),
      c('r', -5, '0423'),
    ]);
    expect(mixta.cobros_monto).toEqual([
      { moneda: 'USD', monto: 600 },
      { moneda: 'MXN', monto: 860.47 },
    ]);
    expect(miniDeFactura(ligada('0420', 'VIGENTE'))).toMatchObject({
      es_parcial: false,
      cobros_n: 0,
      cobros_monto: [],
    });
    expect(resumenCobrosDeFactura('0420', cobros332)).toEqual({
      cobros_n: 1,
      cobros_monto: [{ moneda: 'MXN', monto: 68208 }],
    });
    expect(cobrosAsignables(cobros332).map((x) => x.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
  });

  it('bloque: con la sonda, cobros_sin_factura / _exigen y asignacion_disponible true; sin la sonda 0 / 0 / false y las minis en 0', () => {
    const f = {
      exigencia: 'EXIGE' as const,
      origenes_exigen: ['en Scotiabank Pesos'],
      cobros: cobros332,
    };
    const con = bloqueFacturaServicio(
      SOLICITADA,
      [ligada('0420', 'VIGENTE', { moneda: 'MXN', total: '68208.00' })],
      'Itzi',
      f,
      true,
    );
    expect(con).toMatchObject({
      cobros_sin_factura: 3,
      cobros_sin_factura_exigen: 3,
      asignacion_disponible: true,
    });
    expect(con.facturas[0]).toMatchObject({
      cobros_n: 1,
      cobros_monto: [{ moneda: 'MXN', monto: 68208 }],
    });
    // Un cobro que NO exige (Paywise) cuenta en cobros_sin_factura pero no en _exigen.
    const paywise = bloqueFacturaServicio(
      SOLICITADA,
      [ligada('0420', 'VIGENTE')],
      'Itzi',
      {
        ...f,
        cobros: [
          c('p', 100, null, {
            cuenta_destino: 'Paywise',
            metodo_cobro: 'PAYWISE',
          }),
        ],
      },
      true,
    );
    expect(paywise).toMatchObject({
      cobros_sin_factura: 1,
      cobros_sin_factura_exigen: 0,
    });
    const sin = bloqueFacturaServicio(
      SOLICITADA,
      [ligada('0420', 'VIGENTE')],
      'Itzi',
      f,
    );
    expect(sin).toMatchObject({
      cobros_sin_factura: 0,
      cobros_sin_factura_exigen: 0,
      asignacion_disponible: false,
    });
    expect(sin.facturas[0]).toMatchObject({ cobros_n: 0, cobros_monto: [] });
  });
});
