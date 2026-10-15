import {
  aAbonoDeEntrada,
  alertasConciliacionEntrada,
  anticipoDeEntrada,
  coberturaDeEntrada,
  cruceNoCorrio,
  entradaDeCobroParaHoja,
  entradaDeIngresoParaHoja,
  estadoBancoEntradaDeCobro,
  LIGAS_COBRO_REGISTRADAS_DESDE,
  mismoDiaCliente,
  MISMO_DIA_COBROS_MAX,
  ordenarAbonosDeEntrada,
  registroDeBitacoraIngreso,
  type AbonoDeEntrada,
  type CoberturaDeCobro,
  type EntradaDeConciliacion,
  type LigaParaAbono,
} from './abonos-de-entrada.util';
import {
  coberturaCobro,
  cobroDeUnSoloAbono,
  estadoBancoCobro,
  type ParteCobroBanco,
} from '../../common/cobro-banco.util';
import type { MovimientoLiga } from '../../common/cobro-conciliado.util';
import { lineaOmision } from './omision.util';
import {
  BITACORA,
  C,
  COBROS,
  CTA,
  CUENTAS,
  EC,
  ESTADOS_CUENTA,
  ING,
  INGRESOS,
  M,
  MOVIMIENTOS,
  PARTES,
  U,
  USUARIOS,
  VUELO,
  VUELOS,
  CLIENTES,
  type Row,
} from './conciliacion-entradas.fixture-spec';

/**
 * CONCILIACIÓN AL REVÉS DE UNA ENTRADA (invariante 78) — el modelo PURO con
 * las FILAS REALES de prod (`conciliacion-entradas.fixture-spec`, SELECT del
 * 15-oct-2026). Lo sintético va rotulado.
 */
const nombres = new Map(
  USUARIOS.map((u) => [u.id as string, u.nombre as string]),
);
const porId = (filas: Row[], id: string): Row => {
  const f = filas.find((r) => r.id === id);
  if (!f) throw new Error(`fila ${id} no existe en el fixture`);
  return structuredClone(f);
};
const cuentaDe = (id: string): Row => {
  const {
    activa: _a,
    numero_cuenta: _n,
    clabe: _c,
    ...resto
  } = porId(CUENTAS, id);
  void _a;
  void _n;
  void _c;
  return resto;
};
/** El movimiento como lo devuelve MOV_DETALLE_ABONO_COLS (embeds incluidos). */
function movDetalle(id: string, extra: Row = {}): Row {
  const m = porId(MOVIMIENTOS, id);
  const ec = m.estado_cuenta_id
    ? porId(ESTADOS_CUENTA, m.estado_cuenta_id as string)
    : null;
  return {
    ...m,
    cuenta: porId(CUENTAS, m.cuenta_bancaria_id as string),
    estado_cuenta: ec
      ? {
          ...ec,
          importo: { nombre: nombres.get(ec.created_by as string) ?? null },
        }
      : null,
    creo: { nombre: nombres.get(m.created_by as string) ?? null },
    ...extra,
  };
}
/** El cobro como lo devuelve COBRO_HOJA_COLS. */
function cobroHoja(id: string, extra: Row = {}): Row {
  const c = porId(COBROS, id);
  const v = VUELOS.find((x) => x.id === c.vuelo_id)!;
  const k = CLIENTES.find((x) => x.id === v.cliente_id)!;
  return {
    ...c,
    vuelo: {
      folio: v.folio,
      cliente_id: v.cliente_id,
      cliente: { nombre: k.nombre },
    },
    sobre: null,
    ...extra,
  };
}
const entradaCobro = (id: string): EntradaDeConciliacion =>
  entradaDeCobroParaHoja(cobroHoja(id), nombres);
const parteDe = (movId: string, cobroId: string): Row =>
  PARTES.find((p) => p.movimiento_id === movId && p.cobro_id === cobroId)!;
const ligaDirecta = (movId: string, cobroId: string): LigaParaAbono => {
  const p = parteDe(movId, cobroId);
  return {
    via: 'DIRECTO',
    movimiento_id: movId,
    monto_parte: p.monto_parte as number,
    parte_created_at: p.created_at as string,
    ligada_por: nombres.get(p.created_by as string) ?? null,
  };
};

describe('entradas — mismas reglas que la lista de Ingresos', () => {
  it('#293 (Paywise con comisión): neto con LA fórmula, T.C. de VENTA informativo, concepto null', () => {
    expect(entradaCobro(C.C293)).toEqual({
      origen: 'COBRO_VUELO',
      id: C.C293,
      etiqueta: 'Vuelo #293',
      categoria: 'COBRO_VUELO',
      categoria_etiqueta: 'Cobro de vuelo',
      dia: '2026-09-11',
      monto: 12495,
      comision: 624.76,
      neto: 11870.24,
      moneda: 'MXN',
      tc_usd_mxn: 17,
      metodo: 'PAYWISE',
      metodo_etiqueta: 'Link de pago (Paywise)',
      cliente_nombre: 'Diego Beltra',
      concepto: null,
      vuelo_id: VUELO[293],
      vuelo_folio: 293,
      cuenta: null,
      cuenta_destino: 'Paywise',
      registrado_por_nombre: 'Itzi',
      registrado_at: '2026-09-21T16:43:40.081513+00:00',
      es_reembolso: false,
      dado_de_baja: false,
    });
  });

  it('cobro USD: T.C. null SIEMPRE (aunque la fila trajera uno); #375: concepto = 1.ª línea de las notas; cliente tal cual («Beh Kay » con su espacio)', () => {
    const usd = entradaDeCobroParaHoja(
      cobroHoja(C.C223, { tc_usd_mxn: 18.2 }),
      nombres,
    );
    expect(usd).toMatchObject({ moneda: 'USD', tc_usd_mxn: null, neto: 812 });
    expect(entradaCobro(C.C375)).toMatchObject({
      concepto: 'Pago dos vuelos en uno, el otro es el 21 oct',
      comision: 625.64,
      neto: 15717.95,
    });
    expect(entradaCobro(C.C332).cliente_nombre).toBe('Beh Kay ');
    // Un reembolso (monto negativo) no se toca: neto = monto.
    const reembolso = entradaDeCobroParaHoja(
      cobroHoja(C.C332, { monto: -977.45 }),
      nombres,
    );
    expect(reembolso).toMatchObject({
      monto: -977.45,
      neto: -977.45,
      es_reembolso: true,
    });
  });

  it('ING-3: etiqueta, categoría, cliente ?? pagador, cuenta SIN número ni CLABE; de baja ⇒ dado_de_baja', () => {
    const i = {
      ...porId(INGRESOS, ING.ING3),
      cliente: null,
      vuelo: null,
      cuenta: porId(CUENTAS, CTA.COMBUSTIBLE),
    };
    expect(entradaDeIngresoParaHoja(i, nombres)).toEqual({
      origen: 'INGRESO',
      id: ING.ING3,
      etiqueta: 'ING-3',
      categoria: 'OTRO_INGRESO',
      categoria_etiqueta: 'Otros ingresos',
      dia: '2026-09-10',
      monto: 78,
      comision: null,
      neto: 78,
      moneda: 'MXN',
      tc_usd_mxn: null,
      metodo: 'TRANSFERENCIA',
      metodo_etiqueta: 'Transferencia',
      cliente_nombre: 'didi',
      concepto: 'DLO DIDI RIDES MX (AJUSTE)',
      vuelo_id: null,
      vuelo_folio: null,
      cuenta: cuentaDe(CTA.COMBUSTIBLE),
      cuenta_destino: null,
      registrado_por_nombre: 'Alejandro Canales',
      registrado_at: '2026-10-12T22:57:31.939317+00:00',
      es_reembolso: false,
      dado_de_baja: false,
    });
    const amex = entradaDeIngresoParaHoja(
      {
        ...i,
        cuenta: porId(CUENTAS, CTA.AMEX_ALE),
        deleted_at: '2026-10-15T10:00:00+00:00',
      },
      nombres,
    );
    expect(amex.dado_de_baja).toBe(true);
    expect(JSON.stringify(amex)).not.toMatch(/VENENO|numero_cuenta|clabe/);
    // ING-2 (efectivo, sin cuenta) y una comisión de 0 ⇒ null.
    const ing2 = entradaDeIngresoParaHoja(
      { ...porId(INGRESOS, ING.ING2), comision_monto: 0 },
      nombres,
    );
    expect(ing2).toMatchObject({ cuenta: null, comision: null, neto: 250000 });
  });
});

describe('aAbonoDeEntrada — la base del cargo de un gasto + la liga de la entrada', () => {
  it('ING-3: cuadre NETO 0 con tolerancia 1; registro de la bitácora; archivo e importador; sin veneno', () => {
    const entrada = entradaDeIngresoParaHoja(
      { ...porId(INGRESOS, ING.ING3), cuenta: porId(CUENTAS, CTA.COMBUSTIBLE) },
      nombres,
    );
    const conciliar = registroDeBitacoraIngreso(BITACORA, M.DIDI_78)!;
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.DIDI_78),
      liga: {
        via: 'INGRESO',
        movimiento_id: M.DIDI_78,
        bitacora: {
          registro: {
            por: nombres.get(conciliar.actor_id!)!,
            at: conciliar.at,
          },
          sin_registro: null,
        },
      },
      entrada,
    });
    expect(JSON.stringify(a)).toBe(
      JSON.stringify({
        movimiento_id: M.DIDI_78,
        fecha: '2026-09-10',
        tipo: 'ABONO',
        monto: 78,
        moneda: 'MXN',
        descripcion: 'DLO DIDI RIDES MX (AJUSTE)',
        referencia: '00005579209156174929 REF. 9156174929 AUT. 085488',
        conciliado: true,
        origen: 'IMPORTADO',
        creado_at: '2026-09-29T20:35:24.413103+00:00',
        creado_por: 'Jimmy Chi',
        orden_archivo: null,
        cuenta: cuentaDe(CTA.COMBUSTIBLE),
        estado_cuenta: {
          id: EC.SCOTIA_COMBUS_6,
          filename: 'scotia combus (6).pdf',
          formato: 'pdf',
          importado_at: '2026-09-29T20:35:24.229074+00:00',
          importado_por: 'Jimmy Chi',
          movimientos_importados: 75,
        },
        sin_archivo: null,
        monto_bruto: null,
        comision_pasarela: null,
        liga: {
          via: 'INGRESO',
          monto_parte: null,
          moneda: 'MXN',
          cruzada: false,
          tc_implicito: null,
          cuadre: { por: 'NETO', diferencia: 0, tolerancia: 1 },
          registro: {
            por: 'Alejandro Canales',
            at: '2026-10-12T22:57:32.606618+00:00',
          },
          sin_registro: null,
        },
        lote: null,
        notas_oficina: null,
      }),
    );
  });

  it('#293: cuenta PASARELA, comisión de la pasarela null (el archivo no la trae), parte ANTERIOR_AL_CORTE', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.PAYWISE_293),
      liga: ligaDirecta(M.PAYWISE_293, C.C293),
      entrada: entradaCobro(C.C293),
    });
    expect(a.cuenta).toEqual(cuentaDe(CTA.PAYWISE));
    expect(a.estado_cuenta).toMatchObject({
      filename: 'Reporte de Movimientos Septiembre-2026.pdf',
      importado_por: 'Alejandro Canales',
      movimientos_importados: 34,
    });
    expect(a.comision_pasarela).toBeNull();
    expect(a.liga).toEqual({
      via: 'DIRECTO',
      monto_parte: 11870.24,
      moneda: 'MXN',
      cruzada: false,
      tc_implicito: null,
      cuadre: null,
      registro: null,
      sin_registro: 'ANTERIOR_AL_CORTE',
    });
    // Con el bruto del archivo (sintético): bruto − depositado.
    const conBruto = aAbonoDeEntrada({
      mov: movDetalle(M.PAYWISE_293, { monto_bruto: 12495 }),
      liga: ligaDirecta(M.PAYWISE_293, C.C293),
      entrada: entradaCobro(C.C293),
    });
    expect(conBruto).toMatchObject({
      monto_bruto: 12495,
      comision_pasarela: 624.76,
    });
  });

  it('el SPEI de $69,183.00 visto desde #332 (Diego Ramírez) y desde #315 (backfill ⇒ ANTERIOR_AL_CORTE); el lote TAL CUAL', () => {
    const lote = [
      { cobro_id: C.C315, monto_parte: 68205.55, folio: 315 },
      { cobro_id: C.C332, monto_parte: 977.45, folio: 332 },
    ];
    const mov = movDetalle(M.LOTE_69183, {
      cobros: lote,
      cobros_suma: 69183,
      cobros_diferencia: 0,
    });
    const desde332 = aAbonoDeEntrada({
      mov,
      liga: ligaDirecta(M.LOTE_69183, C.C332),
      entrada: entradaCobro(C.C332),
    });
    expect(desde332.liga).toMatchObject({
      monto_parte: 977.45,
      registro: {
        por: 'Diego Ramírez',
        at: '2026-10-14T21:21:49.025963+00:00',
      },
      sin_registro: null,
    });
    expect(desde332.lote).toEqual({
      cobros_n: 2,
      cobros: lote,
      cobros_suma: 69183,
      cobros_diferencia: 0,
    });
    const desde315 = aAbonoDeEntrada({
      mov,
      liga: ligaDirecta(M.LOTE_69183, C.C315),
      entrada: entradaCobro(C.C315),
    });
    expect(desde315.liga).toMatchObject({
      monto_parte: 68205.55,
      registro: null,
      sin_registro: 'ANTERIOR_AL_CORTE',
    });
    expect(desde315.lote).toEqual(desde332.lote);
    // Sin el detalle (anotarCobrosDeAbonos borró sus llaves) ⇒ cobros null.
    const sinDetalle = aAbonoDeEntrada({
      mov: movDetalle(M.LOTE_69183),
      liga: ligaDirecta(M.LOTE_69183, C.C332),
      entrada: entradaCobro(C.C332),
    });
    expect(sinDetalle.lote).toEqual({
      cobros_n: 2,
      cobros: null,
      cobros_suma: null,
      cobros_diferencia: null,
    });
  });

  it('lote 28340088 ($55,053.00): #254 de Alejandro Canales, #255 de Diego Ramírez', () => {
    const mov = movDetalle(M.LOTE_55053);
    expect(
      aAbonoDeEntrada({
        mov,
        liga: ligaDirecta(M.LOTE_55053, C.C254),
        entrada: entradaCobro(C.C254),
      }).liga.registro,
    ).toEqual({
      por: 'Alejandro Canales',
      at: '2026-10-13T16:51:24.805037+00:00',
    });
    expect(
      aAbonoDeEntrada({
        mov,
        liga: ligaDirecta(M.LOTE_55053, C.C255),
        entrada: entradaCobro(C.C255),
      }).liga.registro,
    ).toEqual({ por: 'Diego Ramírez', at: '2026-10-14T21:24:23.298278+00:00' });
  });

  it('#358: la parte es 38,950.00 contra un neto de 38,950.01 (cubierto, faltante 0.01): monto_parte TAL CUAL', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.PAYWISE_358),
      liga: ligaDirecta(M.PAYWISE_358, C.C358),
      entrada: entradaCobro(C.C358),
    });
    expect(a.liga.monto_parte).toBe(38950);
    expect(entradaCobro(C.C358).neto).toBe(38950.01);
  });

  it('abono sin archivo del 16-jul (REAL, liga SINTÉTICA): IMPORTADO_SIN_ARCHIVO y quién lo importó', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.SIN_ARCHIVO_1811),
      liga: {
        via: 'DIRECTO',
        movimiento_id: M.SIN_ARCHIVO_1811,
        monto_parte: 1811.59,
      },
      entrada: entradaCobro(C.C332),
    });
    expect(a).toMatchObject({
      estado_cuenta: null,
      sin_archivo: 'IMPORTADO_SIN_ARCHIVO',
      creado_at: '2026-07-17T00:34:09.441194+00:00',
      creado_por: 'Jimmy Chi',
      cuenta: cuentaDe(CTA.GASTOS_GNRAL),
    });
    // Sin el autor de la parte (ESPEJO): no se dice nada.
    expect(a.liga).toMatchObject({
      registro: null,
      sin_registro: null,
      monto_parte: 1811.59,
    });
  });

  it('SOBRE (sintético): monto_parte null y NO_SE_GUARDA; ANTICIPO: el registro de su bitácora o por qué no', () => {
    const sobre = aAbonoDeEntrada({
      mov: movDetalle(M.ING4_46550, {
        ingreso_id: null,
        cobro_grupo_id: 'sobre-1',
      }),
      liga: { via: 'SOBRE', movimiento_id: M.ING4_46550 },
      entrada: entradaCobro(C.C315),
    });
    expect(sobre.liga).toEqual({
      via: 'SOBRE',
      monto_parte: null,
      moneda: 'MXN',
      cruzada: false,
      tc_implicito: null,
      cuadre: null,
      registro: null,
      sin_registro: 'NO_SE_GUARDA',
    });
    expect(sobre.lote).toBeNull();
    const base = { via: 'ANTICIPO' as const, movimiento_id: M.ING4_46550 };
    const mov = movDetalle(M.ING4_46550);
    const ent = entradaCobro(C.C315);
    expect(
      aAbonoDeEntrada({
        mov,
        liga: {
          ...base,
          bitacora: {
            registro: {
              por: 'Alejandro Canales',
              at: '2026-10-13T15:42:18.595968+00:00',
            },
            sin_registro: null,
          },
        },
        entrada: ent,
      }).liga,
    ).toMatchObject({
      monto_parte: null,
      registro: { por: 'Alejandro Canales' },
      sin_registro: null,
      cuadre: null,
    });
    expect(
      aAbonoDeEntrada({
        mov,
        liga: {
          ...base,
          bitacora: { registro: null, sin_registro: 'SIN_BITACORA' },
        },
        entrada: ent,
      }).liga.sin_registro,
    ).toBe('SIN_BITACORA');
    expect(
      aAbonoDeEntrada({ mov, liga: base, entrada: ent }).liga.sin_registro,
    ).toBe('NO_LEIDO');
  });

  it('ESPEJO (sin la puente): parte SINTÉTICA = |abono|, sin registro, sin lote', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.PAYWISE_293, { cobros_n: undefined }),
      liga: {
        via: 'DIRECTO',
        movimiento_id: M.PAYWISE_293,
        monto_parte: 11870.24,
      },
      entrada: entradaCobro(C.C293),
    });
    expect(a.liga).toMatchObject({
      monto_parte: 11870.24,
      registro: null,
      sin_registro: null,
    });
    expect(a.lote).toBeNull();
  });

  it('bordes del corte de cobros (12-oct-2026 00:00 Cancún)', () => {
    expect(LIGAS_COBRO_REGISTRADAS_DESDE).toBe('2026-10-12T05:00:00.000Z');
    const con = (at: string) =>
      aAbonoDeEntrada({
        mov: movDetalle(M.LOTE_69183),
        liga: {
          via: 'DIRECTO',
          movimiento_id: M.LOTE_69183,
          monto_parte: 977.45,
          parte_created_at: at,
          ligada_por: 'Diego Ramírez',
        },
        entrada: entradaCobro(C.C332),
      }).liga;
    // La última parte del backfill y el último instante antes del corte.
    expect(con('2026-10-08T18:17:53.188367Z')).toMatchObject({
      registro: null,
      sin_registro: 'ANTERIOR_AL_CORTE',
    });
    expect(con('2026-10-12T04:59:59.999Z')).toMatchObject({
      registro: null,
      sin_registro: 'ANTERIOR_AL_CORTE',
    });
    expect(con('2026-10-12T05:00:00.000Z')).toMatchObject({
      registro: { por: 'Diego Ramírez', at: '2026-10-12T05:00:00.000Z' },
      sin_registro: null,
    });
    // La primera parte real.
    expect(con('2026-10-13T15:56:03.671262Z').registro).toEqual({
      por: 'Diego Ramírez',
      at: '2026-10-13T15:56:03.671262Z',
    });
    // Una parte sin fecha legible: no se dice nada (jamás «anterior»).
    expect(con('ayer')).toMatchObject({ registro: null, sin_registro: null });
  });

  it('cruzada (sintético: cobro USD con abono de la cuenta en pesos) ⇒ T.C. implícito del 0.0.78, jamás el del cobro', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.LOTE_69183),
      liga: {
        via: 'DIRECTO',
        movimiento_id: M.LOTE_69183,
        monto_parte: 14965.16,
      },
      entrada: {
        origen: 'COBRO_VUELO',
        moneda: 'USD',
        monto: 812,
        comision: null,
        neto: 812,
      },
    });
    expect(a.liga).toMatchObject({
      cruzada: true,
      moneda: 'MXN',
      tc_implicito: 18.43,
    });
  });

  it('notas_oficina sin «Omitido de la conciliación: …» ni la línea del vínculo; las crudas no viajan', () => {
    const omision = lineaOmision({
      motivo: 'Prueba de la terminal sin cobro',
      usuario: 'Alejandro Canales',
      hoy: '2026-10-14',
    });
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.PAYWISE_293, { notas: `${omision}\nRevisar con Itzi` }),
      liga: ligaDirecta(M.PAYWISE_293, C.C293),
      entrada: entradaCobro(C.C293),
    });
    expect(a.notas_oficina).toBe('Revisar con Itzi');
  });

  it('JSON sin storage_path, numero_cuenta ni clabe aunque las filas crudas los traigan', () => {
    const a = aAbonoDeEntrada({
      mov: movDetalle(M.DIDI_78, {
        cuenta: porId(CUENTAS, CTA.AMEX_ALE),
        estado_cuenta: {
          ...porId(ESTADOS_CUENTA, EC.SCOTIA_COMBUS_6),
          importo: { nombre: 'Jimmy Chi' },
        },
      }),
      liga: { via: 'INGRESO', movimiento_id: M.DIDI_78, bitacora: null },
      entrada: entradaDeIngresoParaHoja(porId(INGRESOS, ING.ING3), nombres),
    });
    const json = JSON.stringify(a);
    expect(json).not.toMatch(/storage_path|numero_cuenta|clabe|VENENO/);
  });
});

describe('registroDeBitacoraIngreso', () => {
  it('el CONCILIAR de ESE abono; uno de OTRO abono no cuenta (SIN_BITACORA); gana el más reciente', () => {
    expect(registroDeBitacoraIngreso(BITACORA, M.DIDI_78)).toEqual({
      actor_id: U.ALEJANDRO,
      at: '2026-10-12T22:57:32.606618+00:00',
    });
    expect(
      registroDeBitacoraIngreso(BITACORA, M.ING7_4210.toUpperCase()),
    ).toMatchObject({ at: '2026-10-14T22:43:26.093976+00:00' });
    expect(registroDeBitacoraIngreso(BITACORA, M.LOTE_69183)).toBeNull();
    const filas = [
      {
        actor_id: U.ALEJANDRO,
        created_at: '2026-10-12T22:57:32.606618+00:00',
        diff: { movimiento_id: M.DIDI_78 },
      },
      {
        actor_id: U.DIEGO,
        created_at: '2026-10-14T10:00:00+00:00',
        diff: JSON.stringify({ movimiento_id: M.DIDI_78 }),
      },
      {
        actor_id: U.JIMMY,
        created_at: '2026-10-15T10:00:00+00:00',
        diff: { movimiento_id: M.LOTE_69183 },
      },
      {
        actor_id: U.ITZI,
        created_at: '2026-10-16T10:00:00+00:00',
        accion: 'DESCONCILIAR',
        diff: { movimiento_id: M.DIDI_78 },
      },
    ];
    expect(registroDeBitacoraIngreso(filas, M.DIDI_78)).toEqual({
      actor_id: U.DIEGO,
      at: '2026-10-14T10:00:00+00:00',
    });
  });
});

describe('estado y cobertura — las del 0.0.78 TAL CUAL', () => {
  const parte = (
    monto: number,
    extra: Partial<ParteCobroBanco> = {},
  ): ParteCobroBanco => ({
    movimiento_id: 'm-1',
    cobro_id: 'c-1',
    monto_parte: monto,
    moneda_cuenta: 'MXN',
    pasarela: false,
    fecha: '2026-09-15',
    created_at: '2026-10-06T15:22:46Z',
    monto_abono: monto,
    cobros_n: 1,
    cuenta_bancaria_id: CTA.EJE_SCOTIA,
    cuenta_alias: 'EJE SCOTIA',
    ...extra,
  });
  it('estadoBancoEntradaDeCobro = identidad sobre la tabla completa de estadoBancoCobro', () => {
    const casos: Array<[Parameters<typeof estadoBancoCobro>[0], string]> = [
      [
        {
          monto: 977.45,
          metodo: 'TRANSFERENCIA',
          via: 'DIRECTO',
          cobertura: { cubierto: true },
        },
        'CONCILIADO',
      ],
      [
        {
          monto: 3400,
          metodo: 'TRANSFERENCIA',
          via: 'DIRECTO',
          cobertura: { cubierto: false },
        },
        'PARCIAL',
      ],
      [
        { monto: 3400, metodo: 'TRANSFERENCIA', via: 'SOBRE', cobertura: null },
        'CONCILIADO',
      ],
      [
        {
          monto: 20000,
          metodo: 'TRANSFERENCIA',
          via: 'ANTICIPO',
          cobertura: { cubierto: true },
        },
        'VIA_ANTICIPO',
      ],
      [
        { monto: 20000, metodo: 'TRANSFERENCIA', via: null, cobertura: null },
        'SIN_CONCILIAR',
      ],
      [
        { monto: 812, metodo: 'HSBC_LINK', via: null, cobertura: null },
        'SIN_CONCILIAR',
      ],
      [
        { monto: 812, metodo: 'BILLPOCKET', via: null, cobertura: null },
        'NO_BANCARIO',
      ],
      [
        { monto: -500, metodo: 'TRANSFERENCIA', via: null, cobertura: null },
        'NO_BANCARIO',
      ],
      [
        {
          monto: 977.45,
          metodo: 'TRANSFERENCIA',
          via: 'DIRECTO',
          cobertura: null,
        },
        'CONCILIADO',
      ],
    ];
    for (const [entrada, esperado] of casos) {
      expect(estadoBancoEntradaDeCobro(estadoBancoCobro(entrada))).toBe(
        esperado,
      );
    }
  });

  it('coberturaDeEntrada copia 1:1 (n_partes ⇒ abonos_n; tolerancia 1.00) en el orden de la respuesta', () => {
    const cob = coberturaCobro(
      { monto: 41000.01, moneda: 'MXN', comision_banco_monto: 2050 },
      [parte(38950)],
    );
    const r: CoberturaDeCobro = coberturaDeEntrada(cob);
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        neto: 38950.01,
        monto_vinculado: 38950,
        faltante: 0.01,
        sobrante: 0,
        cubierto: true,
        abonos_n: 1,
        cruzado: false,
        tolerancia: 1,
      }),
    );
    expect(
      coberturaDeEntrada(
        coberturaCobro({ monto: 3400, moneda: 'MXN' }, [parte(1700)]),
      ),
    ).toMatchObject({
      monto_vinculado: 1700,
      faltante: 1700,
      cubierto: false,
      abonos_n: 1,
    });
  });

  it('«de un solo abono» del 0.0.78 (R9): #293/#358 y #375 ⇒ sí; #332 y #223 ⇒ no', () => {
    const fila = (id: string) => porId(COBROS, id);
    expect(cobroDeUnSoloAbono(fila(C.C293), [])).toBe(true);
    expect(cobroDeUnSoloAbono(fila(C.C358), [])).toBe(true);
    expect(cobroDeUnSoloAbono(fila(C.C375), [])).toBe(true);
    expect(
      cobroDeUnSoloAbono(fila(C.C332), [parte(977.45, { cobros_n: 2 })]),
    ).toBe(false);
    expect(cobroDeUnSoloAbono(fila(C.C223), [])).toBe(false);
  });
});

describe('alertasConciliacionEntrada — 3 códigos, en orden; jamás TC_NO_REGISTRADO', () => {
  const abono = (lote: AbonoDeEntrada['lote'] = null): AbonoDeEntrada =>
    ({
      movimiento_id: 'm',
      fecha: '2026-09-15',
      lote,
    }) as unknown as AbonoDeEntrada;
  const cob = (sobrante: number): CoberturaDeCobro => ({
    neto: 1000,
    monto_vinculado: 1000 + sobrante,
    faltante: 0,
    sobrante,
    cubierto: true,
    abonos_n: 1,
    cruzado: false,
    tolerancia: 1,
  });
  it('las tres, en orden; con el sobrante dentro de la tolerancia, nada', () => {
    expect(
      alertasConciliacionEntrada({
        estado: 'CONCILIADO',
        via: 'DIRECTO',
        cobertura: cob(500),
        abonos: [],
      }),
    ).toEqual(['CONCILIADO_SIN_ABONOS', 'ABONO_CON_SOBRANTE']);
    expect(
      alertasConciliacionEntrada({
        estado: 'CONCILIADO',
        via: 'DIRECTO',
        cobertura: cob(1),
        abonos: [
          abono({
            cobros_n: 2,
            cobros: null,
            cobros_suma: null,
            cobros_diferencia: null,
          }),
        ],
      }),
    ).toEqual(['LOTE_SIN_DETALLE']);
    for (const estado of ['VIA_ANTICIPO', 'PARCIAL'] as const) {
      expect(
        alertasConciliacionEntrada({
          estado,
          via: null,
          cobertura: null,
          abonos: [],
        }),
      ).toEqual(['CONCILIADO_SIN_ABONOS']);
    }
    expect(
      alertasConciliacionEntrada({
        estado: 'SIN_CONCILIAR',
        via: null,
        cobertura: null,
        abonos: [],
      }),
    ).toEqual([]);
    // Una liga cruzada sin T.C. del cobro (USD: 97/97 sin él) no alerta.
    const cruzado: CoberturaDeCobro = { ...cob(0), cruzado: true };
    expect(
      alertasConciliacionEntrada({
        estado: 'CONCILIADO',
        via: 'DIRECTO',
        cobertura: cruzado,
        abonos: [abono()],
      }),
    ).toEqual([]);
  });

  it('ordenarAbonosDeEntrada: por fecha y luego por id', () => {
    const a = (movimiento_id: string, fecha: string) =>
      ({ movimiento_id, fecha }) as AbonoDeEntrada;
    expect(
      ordenarAbonosDeEntrada([
        a('b', '2026-09-16'),
        a('c', '2026-09-15'),
        a('a', '2026-09-16'),
      ]).map((x) => x.movimiento_id),
    ).toEqual(['c', 'a', 'b']);
  });
});

describe('mismoDiaCliente (D13) — los lotes del mismo día de prod', () => {
  const filaMismoDia = (id: string, extra: Row = {}): Row => {
    const c = porId(COBROS, id);
    const v = VUELOS.find((x) => x.id === c.vuelo_id)!;
    return { ...c, folio: v.folio, ...extra };
  };
  const sinLigas: MovimientoLiga[] = [];

  it('Palma #379 ⇒ [#380], suma $59,081.00', () => {
    expect(
      mismoDiaCliente([filaMismoDia(C.C380)], sinLigas, entradaCobro(C.C379)),
    ).toEqual({
      cliente: 'Palma',
      dia: '2026-10-06',
      moneda: 'MXN',
      cobros: [
        {
          cobro_id: C.C380,
          vuelo_id: VUELO[380],
          folio: 380,
          monto: 29540.5,
          neto: 29540.5,
        },
      ],
      n: 1,
      suma_netos: 59081,
    });
  });

  it('ACP #295 ⇒ [#296, #297, #323] por folio, suma $6,873.00 USD; January Davila #375 ⇒ [#376], suma de NETOS $31,435.90', () => {
    const acp = mismoDiaCliente(
      [filaMismoDia(C.C323), filaMismoDia(C.C297), filaMismoDia(C.C296)],
      sinLigas,
      entradaCobro(C.C295),
    )!;
    expect(acp.cobros.map((c) => c.folio)).toEqual([296, 297, 323]);
    expect(acp).toMatchObject({
      n: 3,
      suma_netos: 6873,
      moneda: 'USD',
      cliente: 'ACP',
    });
    const january = mismoDiaCliente(
      [filaMismoDia(C.C376)],
      sinLigas,
      entradaCobro(C.C375),
    )!;
    expect(january.cobros).toEqual([
      {
        cobro_id: C.C376,
        vuelo_id: VUELO[376],
        folio: 376,
        monto: 16343.59,
        neto: 15717.95,
      },
    ]);
    expect(january.suma_netos).toBe(31435.9);
  });

  it('Morena Mia #223 ⇒ [#198, #226], suma $2,407.00 USD', () => {
    expect(
      mismoDiaCliente(
        [filaMismoDia(C.C226), filaMismoDia(C.C198)],
        sinLigas,
        entradaCobro(C.C223),
      ),
    ).toMatchObject({
      cobros: [
        { folio: 198, monto: 783 },
        { folio: 226, monto: 812 },
      ],
      n: 2,
      suma_netos: 2407,
    });
  });

  it('un cobro del mismo día CON liga no entra (fixture: #254 sin liga y #255 ligado ⇒ #255 fuera ⇒ null)', () => {
    const ligas: MovimientoLiga[] = [
      {
        id: M.LOTE_55053,
        cobro_id: C.C255,
        cobro_grupo_id: null,
        monto_parte: 27526.5,
      },
    ];
    expect(
      mismoDiaCliente([filaMismoDia(C.C255)], ligas, entradaCobro(C.C254)),
    ).toBeNull();
    expect(
      mismoDiaCliente([filaMismoDia(C.C255)], [], entradaCobro(C.C254)),
    ).toMatchObject({ n: 1, suma_netos: 55053 });
  });

  it('se re-filtra lo que la BD ya filtró: otro día, otra moneda, este mismo, de sobre, de anticipo, no bancario, reembolso', () => {
    const e = entradaCobro(C.C379);
    const filas = [
      filaMismoDia(C.C379),
      filaMismoDia(C.C380, { fecha_cobro: '2026-10-07T17:00:00+00:00' }),
      filaMismoDia(C.C380, { id: 'x-usd', moneda: 'USD' }),
      filaMismoDia(C.C380, { id: 'x-sobre', cobro_grupo_id: 'sobre-1' }),
      filaMismoDia(C.C380, { id: 'x-anticipo', ingreso_anticipo_id: 'ing-12' }),
      filaMismoDia(C.C380, { id: 'x-efectivo', metodo_cobro: 'EFECTIVO' }),
      filaMismoDia(C.C380, { id: 'x-reembolso', monto: -100 }),
      // 23:30 Cancún del 06-oct = 04:30Z del 07: sigue siendo el MISMO día.
      filaMismoDia(C.C380, {
        id: 'x-noche',
        fecha_cobro: '2026-10-07T04:30:00+00:00',
      }),
    ];
    const r = mismoDiaCliente(filas, [], e)!;
    expect(r.cobros.map((c) => c.cobro_id)).toEqual(['x-noche']);
  });

  it('más de 10 ⇒ 10 por folio y `n` completo; la suma incluye a TODOS', () => {
    const filas = Array.from({ length: 12 }, (_, i) =>
      filaMismoDia(C.C380, {
        id: `c-${String(i).padStart(2, '0')}`,
        folio: 500 - i,
        monto: 100,
      }),
    );
    const r = mismoDiaCliente(filas, [], entradaCobro(C.C379))!;
    expect(r.cobros).toHaveLength(MISMO_DIA_COBROS_MAX);
    expect(r.cobros[0].folio).toBe(489);
    expect(r.n).toBe(12);
    expect(r.suma_netos).toBe(30740.5);
  });

  it('sin otros ⇒ null; cruceNoCorrio(0) ⇒ null', () => {
    expect(mismoDiaCliente([], [], entradaCobro(C.C383))).toBeNull();
    expect(cruceNoCorrio(0, '2026-10-05', '2026-10-11')).toBeNull();
    expect(cruceNoCorrio(null, '2026-10-05', '2026-10-11')).toBeNull();
    expect(cruceNoCorrio(4, '2026-10-05', '2026-10-11')).toEqual({
      abonos_previos: 4,
      desde: '2026-10-05',
      hasta: '2026-10-11',
    });
  });
});

describe('anticipoDeEntrada (sintético: 0 anticipos en prod)', () => {
  it('ING-12 de $50,000.00 conciliado', () => {
    expect(
      anticipoDeEntrada(
        {
          id: 'ing-12',
          folio: 12,
          monto: 50000,
          moneda: 'MXN',
          fecha: '2026-09-01',
          cuenta_bancaria_id: CTA.EJE_SCOTIA,
        },
        true,
      ),
    ).toEqual({
      ingreso_id: 'ing-12',
      etiqueta: 'ING-12',
      monto: 50000,
      moneda: 'MXN',
      dia: '2026-09-01',
      cuenta_bancaria_id: CTA.EJE_SCOTIA,
      conciliado: true,
    });
  });
});
