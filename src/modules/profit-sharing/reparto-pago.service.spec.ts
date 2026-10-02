// Las utilidades salen de ProfitSharingService.utilidadesSociosPorMes (aquí
// un doble): el servicio real arrastra pyservices/tipo de cambio/conciliación.
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { Rol } from '../../common/types/auth.types';
import type { CrearPagoSocioDto } from './dto/reparto-pago.dto';
import {
  AERO,
  ALE,
  BAJA,
  KEY,
  KEY2,
  MARY,
  MAURICIO,
  N4142R,
  N990GG,
  PILOTO,
  avionN4142R,
  errorDe,
  mundo,
  pagoFila,
} from './reparto-cuenta.fixture-spec';
import type { RepartoAvionInput } from './reparto-cuenta.util';

/** N4142R en OCTUBRE (mes en curso): solo Mauricio con `m` (parcial). */
function octubreN4142R(m: number): RepartoAvionInput {
  const a = avionN4142R();
  return {
    ...a,
    reparto: a.reparto.map((r) => ({
      ...r,
      monto_usd: r.socio_id === MAURICIO ? m : 0,
    })),
  };
}

/**
 * ENTREGAS A LA CUENTA DEL SOCIO (v2, 2-oct-2026) contra la BD en memoria:
 * alta USD/MXN, el ADELANTO del audio (70,000 MXN a 18.5) con 409 y con
 * `aceptar_exceso`, «corresponde a» mes/avión, idempotencia y carreras,
 * PATCH con el saldo sin la propia entrega y CAS, soft delete, comprobante,
 * listado por fechas (SOCIO solo las suyas, 410 por mes) y sin la migración.
 * Mauricio Roque: septiembre 2026 generó $1,395.94 (69 % de $2,023.10).
 */
const ADMIN = { userId: ALE, rol: Rol.ADMIN };
const MARY_FACT = { userId: MARY, rol: Rol.FACTURACION };

function dtoAlta(p: Partial<CrearPagoSocioDto> = {}): CrearPagoSocioDto {
  return {
    socio_id: MAURICIO,
    monto: 1395.94,
    moneda: 'USD',
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    ...p,
  };
}

/** El caso del audio: «adelántenme 70,000 pesos de mis utilidades». */
const ADELANTO_70K: Partial<CrearPagoSocioDto> = {
  monto: 70000,
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  metodo: 'EFECTIVO',
  recibido_por: 'El socio en persona',
};

describe('RepartoPagoService.crear', () => {
  it('entrega USD que «corresponde a» septiembre y al avión: saldo antes guardado, entregó = el actor; cuenta recalculada', async () => {
    const { pagos, tablas } = mundo();
    const r = await pagos.crear(
      dtoAlta({
        mes: '2026-09',
        aeronave_id: N4142R,
        referencia: ' SPEI 1 ',
        client_request_id: KEY,
      }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toEqual([
      expect.objectContaining({
        socio_id: MAURICIO,
        aeronave_id: N4142R,
        periodo: '2026-09-01',
        monto: 1395.94,
        moneda: 'USD',
        tc_usd_mxn: null,
        monto_usd: 1395.94,
        utilidad_snapshot_usd: null,
        saldo_snapshot_usd: 1395.94,
        entregado_por: ALE,
        created_by: ALE,
        referencia: 'SPEI 1',
        client_request_id: KEY,
      }),
    ]);
    expect(r.pago).toMatchObject({
      mes: '2026-09',
      aeronave: { id: N4142R, matricula: 'N4142R' },
      entregado_por_nombre: 'Ale Canales',
    });
    expect(r.cuenta).toMatchObject({
      socio: { id: MAURICIO },
      generado_usd: 1395.94,
      entregado_usd: 1395.94,
      por_entregar_usd: 0,
      estado: 'AL_CORRIENTE',
    });
    expect(r).not.toHaveProperty('idempotente');
  });

  it('el ADELANTO de 70,000 MXN a 18.5: 409 PAGO_EXCEDE_SALDO sin escribir; con aceptar_exceso y la MISMA llave se guarda y la cuenta queda ADELANTADA', async () => {
    const { pagos, tablas } = mundo();
    const e = await errorDe(
      pagos.crear(dtoAlta({ ...ADELANTO_70K, client_request_id: KEY }), ADMIN),
    );
    expect(e).toEqual({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      message:
        'Esta entrega de $3,783.78 USD supera lo que hay por entregar ($1,395.94 USD). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $2,387.84 USD. ¿Registrar?',
      details: {
        por_entregar_usd: 1395.94,
        mes_en_curso_usd: 0,
        monto_usd: 3783.78,
        exceso_usd: 2387.84,
        saldo_despues_usd: -2387.84,
      },
    });
    expect(tablas.reparto_pago).toHaveLength(0);
    const r = await pagos.crear(
      dtoAlta({
        ...ADELANTO_70K,
        client_request_id: KEY,
        aceptar_exceso: true,
      }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toEqual([
      expect.objectContaining({
        aeronave_id: null,
        periodo: null,
        monto: 70000,
        moneda: 'MXN',
        tc_usd_mxn: 18.5,
        monto_usd: 3783.78,
        saldo_snapshot_usd: 1395.94,
        metodo: 'EFECTIVO',
        recibido_por: 'El socio en persona',
      }),
    ]);
    expect(r.pago).toMatchObject({ mes: null, aeronave: null });
    expect(r.cuenta).toMatchObject({
      entregado_usd: 3783.78,
      por_entregar_usd: -2387.84,
      estado: 'ADELANTADO',
    });
  });

  it('candado contra MESES CERRADOS: con octubre (en curso) en −$345, entregar exactamente lo de septiembre NO pide confirmar; con octubre en +$500 a medias, entregar $1,895.94 SÍ (y el 409 dice cuánto lleva el mes en curso)', async () => {
    const neg = mundo({
      utilidades: {
        '2026-09': [avionN4142R()],
        '2026-10': [octubreN4142R(-345)],
      },
    });
    const r = await neg.pagos.crear(dtoAlta({ monto: 1395.94 }), ADMIN);
    expect(neg.tablas.reparto_pago).toEqual([
      // El snapshot guarda el número contra el que se decidió (cerrado).
      expect.objectContaining({
        monto_usd: 1395.94,
        saldo_snapshot_usd: 1395.94,
      }),
    ]);
    expect(r.cuenta).toMatchObject({
      por_entregar_usd: -345,
      mes_en_curso_usd: -345,
      por_entregar_cerrado_usd: 0,
    });
    // La escritura decide con utilidades FRESCAS (sin la memoria de 10 min).
    expect(neg.utilidadesSociosPorMes).toHaveBeenCalledWith(
      ['2026-09', '2026-10'],
      '2026-10',
      { fresco: true },
    );

    const pos = mundo({
      utilidades: {
        '2026-09': [avionN4142R()],
        '2026-10': [octubreN4142R(500)],
      },
    });
    expect(
      await errorDe(pos.pagos.crear(dtoAlta({ monto: 1895.94 }), ADMIN)),
    ).toEqual({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      message:
        'Esta entrega de $1,895.94 USD supera lo que hay por entregar ($1,395.94 USD, sin contar el mes en curso: $500 USD). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $500 USD. ¿Registrar?',
      details: {
        por_entregar_usd: 1395.94,
        mes_en_curso_usd: 500,
        monto_usd: 1895.94,
        exceso_usd: 500,
        saldo_despues_usd: -500,
      },
    });
    expect(pos.tablas.reparto_pago).toHaveLength(0);
  });

  it('dentro de la tolerancia de $1 no es adelanto', async () => {
    const { pagos, tablas } = mundo();
    await pagos.crear(dtoAlta({ monto: 1396.94 }), ADMIN);
    expect(tablas.reparto_pago).toHaveLength(1);
  });

  it('socio que no es de ningún avión ⇒ 400 SOCIO_INVALIDO; avión que no es suyo ⇒ 400 SOCIO_NO_ES_DE_LA_AERONAVE; sin calcular utilidades', async () => {
    const { pagos, tablas, utilidadesSociosPorMes } = mundo();
    expect(
      await errorDe(pagos.crear(dtoAlta({ socio_id: PILOTO }), ADMIN)),
    ).toMatchObject({ status: 400, code: 'SOCIO_INVALIDO' });
    expect(
      await errorDe(
        pagos.crear(dtoAlta({ socio_id: AERO, aeronave_id: N990GG }), ADMIN),
      ),
    ).toMatchObject({ status: 400, code: 'SOCIO_NO_ES_DE_LA_AERONAVE' });
    // N990GG sí fue de Mauricio (hasta julio): «corresponde a» es
    // informativo, cualquier vigencia vale.
    await pagos.crear(dtoAlta({ monto: 10, aeronave_id: N990GG }), ADMIN);
    expect(tablas.reparto_pago).toHaveLength(1);
    // Los rechazos no calcularon nada y la respuesta del alta REUTILIZA las
    // utilidades de la misma petición (el mes en curso no se recalcula).
    expect(utilidadesSociosPorMes).toHaveBeenCalledTimes(1);
  });

  it('reglas de forma: T.C. según moneda y banda, fecha no futura, mes no futuro, quién entregó activo', async () => {
    const { pagos, tablas } = mundo();
    const code = async (p: Partial<CrearPagoSocioDto>) =>
      (await errorDe(pagos.crear(dtoAlta(p), ADMIN))).code;
    expect(await code({ moneda: 'MXN', monto: 100 })).toBe('TC_REQUERIDO');
    expect(await code({ tc_usd_mxn: 18.2 })).toBe('TC_NO_APLICA');
    expect(await code({ moneda: 'MXN', monto: 70000, tc_usd_mxn: 1.85 })).toBe(
      'TC_FUERA_DE_RANGO',
    );
    expect(await code({ fecha_pago: '2026-10-02' })).toBe('FECHA_PAGO_FUTURA');
    expect(await code({ mes: '2026-11' })).toBe('MES_FUTURO');
    expect(await code({ entregado_por_id: BAJA })).toBe(
      'ENTREGADO_POR_INVALIDO',
    );
    expect(tablas.reparto_pago).toHaveLength(0);
    // Entregó otra persona (activa): se respeta.
    await pagos.crear(dtoAlta({ monto: 100, entregado_por_id: MARY }), ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      entregado_por: MARY,
      created_by: ALE,
    });
  });

  it('idempotencia: el replay devuelve LA MISMA entrega (200) sin escribir, aunque hoy «excedería»; llave de otro socio ⇒ 409', async () => {
    const { pagos, tablas } = mundo();
    const a = await pagos.crear(
      dtoAlta({ monto: 1000, client_request_id: KEY }),
      ADMIN,
    );
    const b = await pagos.crear(
      dtoAlta({ monto: 1000, client_request_id: KEY }),
      ADMIN,
    );
    expect(b.idempotente).toBe(true);
    expect(b.pago.id).toBe(a.pago.id);
    expect(b.cuenta.por_entregar_usd).toBe(395.94);
    expect(tablas.reparto_pago).toHaveLength(1);
    expect(
      await errorDe(
        pagos.crear(dtoAlta({ socio_id: AERO, client_request_id: KEY }), ADMIN),
      ),
    ).toMatchObject({ status: 409, code: 'CLIENT_REQUEST_ID_EN_USO' });
  });

  it('doble envío con la MISMA llave: la 2.ª ve la entrega de la 1.ª en el saldo y aun así responde 200 idempotente (no 409)', async () => {
    const { pagos, tablas, utilidadesSociosPorMes } = mundo();
    let soltar!: () => void;
    const r1Lista = new Promise<void>((r) => (soltar = r));
    const original = utilidadesSociosPorMes.getMockImplementation()!;
    let llamada = 0;
    utilidadesSociosPorMes.mockImplementation(async (meses, mesActual) => {
      llamada += 1;
      if (llamada === 2) await r1Lista;
      return original(meses, mesActual);
    });
    const dto = dtoAlta({ client_request_id: KEY });
    const p1 = pagos.crear(dto, ADMIN);
    const p2 = pagos.crear({ ...dto }, ADMIN);
    const r1 = await p1;
    soltar();
    const r2 = await p2;
    expect(r1).not.toHaveProperty('idempotente');
    expect(r2.idempotente).toBe(true);
    expect(r2.pago.id).toBe(r1.pago.id);
    expect(tablas.reparto_pago).toHaveLength(1);
  });

  it('dos entregas simultáneas con llaves DISTINTAS que juntas rebasan: la capturada después se da de baja (llave libre) y responde 409; confirmarla con la MISMA llave la guarda', async () => {
    const { pagos, tablas, utilidadesSociosPorMes } = mundo();
    // Puerta: las dos primeras lecturas del saldo esperan a que lleguen ambas.
    let llegadas = 0;
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const original = utilidadesSociosPorMes.getMockImplementation()!;
    utilidadesSociosPorMes.mockImplementation(async (meses, mesActual) => {
      llegadas += 1;
      if (llegadas === 2) soltar();
      if (llegadas <= 2) await puerta;
      return original(meses, mesActual);
    });
    const res = await Promise.allSettled([
      pagos.crear(dtoAlta({ monto: 1000, client_request_id: KEY }), ADMIN),
      pagos.crear(dtoAlta({ monto: 1000, client_request_id: KEY2 }), MARY_FACT),
    ]);
    expect(tablas.reparto_pago).toHaveLength(2);
    const ganadora = res.findIndex((r) => r.status === 'fulfilled');
    const perdedora = res.findIndex((r) => r.status === 'rejected');
    expect([ganadora, perdedora].sort()).toEqual([0, 1]);
    const e = await errorDe(
      Promise.reject((res[perdedora] as PromiseRejectedResult).reason as Error),
    );
    expect(e).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      details: {
        por_entregar_usd: 395.94,
        monto_usd: 1000,
        exceso_usd: 604.06,
        saldo_despues_usd: -604.06,
      },
    });
    const vivas = tablas.reparto_pago.filter((f) => f.deleted_at == null);
    expect(vivas.map((f) => f.client_request_id)).toEqual([
      [KEY, KEY2][ganadora],
    ]);
    const baja = tablas.reparto_pago.find((f) => f.deleted_at != null)!;
    expect(String(vivas[0].created_at) < String(baja.created_at)).toBe(true);
    expect(baja).toMatchObject({
      deleted_by: [ALE, MARY][perdedora],
      client_request_id: null,
    });
    expect(String(baja.motivo_baja)).toContain('al mismo tiempo');
    // El panel confirma el ADELANTO con la MISMA llave.
    const r = await pagos.crear(
      dtoAlta({
        monto: 1000,
        client_request_id: [KEY, KEY2][perdedora],
        aceptar_exceso: true,
      }),
      [ADMIN, MARY_FACT][perdedora],
    );
    expect(r.cuenta).toMatchObject({
      entregado_usd: 2000,
      por_entregar_usd: -604.06,
      estado: 'ADELANTADO',
    });
  });

  it('22003 (numeric fuera de rango) de la BD ⇒ 400 PAGO_INVALIDO, nunca 500', async () => {
    const { pagos } = mundo({
      errorEnInsert: { code: '22003', message: 'numeric field overflow' },
    });
    expect(
      await errorDe(pagos.crear(dtoAlta({ monto: 10 }), ADMIN)),
    ).toMatchObject({
      status: 400,
      code: 'PAGO_INVALIDO',
    });
  });

  it('sin la migración: 503 CUENTA_SOCIO_NO_DISPONIBLE', async () => {
    const { pagos } = mundo({ sinMigracion: true });
    expect(await errorDe(pagos.crear(dtoAlta(), ADMIN))).toMatchObject({
      status: 503,
      code: 'CUENTA_SOCIO_NO_DISPONIBLE',
      details: { migracion: '20261002000001' },
    });
  });
});

describe('RepartoPagoService.actualizar', () => {
  const PAGO = 'dddddddd-0000-4000-8000-000000000001';

  it('solo metadatos: no re-valida el saldo y escribe SOLO lo que cambió', async () => {
    const { pagos, escrituras } = mundo({
      pagos: [pagoFila({ monto: 3000, monto_usd: 3000 })],
    });
    const r = await pagos.actualizar(
      PAGO,
      { notas: 'Recibió su contador' },
      ADMIN,
    );
    const upd = escrituras.filter((e) => e.op === 'update');
    expect(upd).toHaveLength(1);
    // Solo lo que cambió + quién corrigió (actor de la bitácora).
    expect(upd[0].valor).toEqual({
      notas: 'Recibió su contador',
      updated_by: ALE,
    });
    expect(r.cuenta).toMatchObject({
      por_entregar_usd: -1604.06,
      estado: 'ADELANTADO',
    });
  });

  it('subir el monto se mide contra el saldo SIN esta entrega; con aceptar_exceso pasa y renueva saldo_snapshot', async () => {
    const { pagos, tablas } = mundo({
      pagos: [pagoFila({ saldo_snapshot_usd: 999 })],
    });
    const e = await errorDe(pagos.actualizar(PAGO, { monto: 1500 }, ADMIN));
    expect(e).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      details: {
        por_entregar_usd: 1395.94,
        monto_usd: 1500,
        exceso_usd: 104.06,
        saldo_despues_usd: -104.06,
      },
    });
    const r = await pagos.actualizar(
      PAGO,
      { monto: 1500, aceptar_exceso: true },
      ADMIN,
    );
    expect(tablas.reparto_pago[0]).toMatchObject({
      monto: 1500,
      monto_usd: 1500,
      saldo_snapshot_usd: 1395.94,
    });
    expect(r.cuenta.por_entregar_usd).toBe(-104.06);
  });

  it('bajar el monto nunca se bloquea; pasar a MXN exige T.C.; a USD lo limpia', async () => {
    const { pagos, tablas } = mundo({
      pagos: [pagoFila({ monto: 3000, monto_usd: 3000 })],
    });
    await pagos.actualizar(PAGO, { monto: 2000 }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({ monto_usd: 2000 });
    expect(
      (await errorDe(pagos.actualizar(PAGO, { moneda: 'MXN' }, ADMIN))).code,
    ).toBe('TC_REQUERIDO');
    await pagos.actualizar(
      PAGO,
      { moneda: 'MXN', monto: 20000, tc_usd_mxn: 18.5 },
      ADMIN,
    );
    expect(tablas.reparto_pago[0]).toMatchObject({
      moneda: 'MXN',
      tc_usd_mxn: 18.5,
      monto_usd: 1081.08,
    });
    await pagos.actualizar(PAGO, { moneda: 'USD', monto: 100 }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      moneda: 'USD',
      tc_usd_mxn: null,
      monto_usd: 100,
    });
  });

  it('corregir la entrega de alguien que YA no está en aeronave_socio sí se puede (el alta no)', async () => {
    const { pagos, tablas } = mundo({
      pagos: [pagoFila({ socio_id: PILOTO, aeronave_id: null, periodo: null })],
    });
    const r = await pagos.actualizar(PAGO, { referencia: 'SPEI 999' }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({ referencia: 'SPEI 999' });
    expect(r.cuenta).toMatchObject({
      socio: { id: PILOTO },
      por_entregar_usd: -1000,
      estado: 'ADELANTADO',
    });
    expect(
      await errorDe(pagos.crear(dtoAlta({ socio_id: PILOTO }), ADMIN)),
    ).toMatchObject({ status: 400, code: 'SOCIO_INVALIDO' });
  });

  it('«corresponde a» se corrige: mes y avión a null (adelanto a cuenta) o a otro avión del socio', async () => {
    const { pagos, tablas } = mundo({ pagos: [pagoFila()] });
    const r = await pagos.actualizar(
      PAGO,
      { mes: null, aeronave_id: null },
      ADMIN,
    );
    expect(tablas.reparto_pago[0]).toMatchObject({
      periodo: null,
      aeronave_id: null,
    });
    expect(r.pago).toMatchObject({ mes: null, aeronave: null });
    expect(
      await errorDe(
        pagos.actualizar(
          PAGO,
          { aeronave_id: 'aaaaaaaa-0000-4000-8000-0000000000ff' },
          ADMIN,
        ),
      ),
    ).toMatchObject({ code: 'SOCIO_NO_ES_DE_LA_AERONAVE' });
    expect(
      await errorDe(pagos.actualizar(PAGO, { mes: '2026-12' }, ADMIN)),
    ).toMatchObject({
      code: 'MES_FUTURO',
    });
  });

  it('cuerpo vacío ⇒ 400; entrega borrada ⇒ 404; CAS por updated_at ⇒ 409', async () => {
    const { pagos } = mundo({
      pagos: [pagoFila({ deleted_at: '2026-10-01T16:00:00Z' })],
    });
    expect((await errorDe(pagos.actualizar(PAGO, {}, ADMIN))).code).toBe(
      'PAGO_SIN_CAMBIOS',
    );
    expect(
      await errorDe(pagos.actualizar(PAGO, { notas: 'x' }, ADMIN)),
    ).toMatchObject({ status: 404, code: 'PAGO_NO_EXISTE' });

    const m = mundo({ pagos: [pagoFila()] });
    const original = m.tablas.reparto_pago[0];
    // Otra persona lo cambia entre la lectura y la escritura.
    const svc = m.pagos as unknown as {
      pagoVivo: (id: string) => Promise<Record<string, unknown>>;
    };
    const leer = svc.pagoVivo.bind(m.pagos);
    svc.pagoVivo = async (id: string) => {
      const r = await leer(id);
      original.updated_at = '2026-10-01T17:00:00.000000+00:00';
      return r;
    };
    expect(
      await errorDe(m.pagos.actualizar(PAGO, { notas: 'x' }, ADMIN)),
    ).toMatchObject({ status: 409, code: 'PAGO_CAMBIO_CONCURRENTE' });
  });
});

describe('RepartoPagoService.eliminar', () => {
  const PAGO = 'dddddddd-0000-4000-8000-000000000001';

  it('soft delete: la fila se conserva con quién/cuándo/motivo y la cuenta vuelve a POR ENTREGAR', async () => {
    const { pagos, tablas } = mundo({ pagos: [pagoFila()] });
    const r = await pagos.eliminar(PAGO, '  Capturado dos veces ', ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      deleted_by: ALE,
      motivo_baja: 'Capturado dos veces',
    });
    expect(tablas.reparto_pago[0].deleted_at).toBeTruthy();
    expect(r).toMatchObject({
      deleted: true,
      cuenta: {
        entregado_usd: 0,
        por_entregar_usd: 1395.94,
        estado: 'POR_ENTREGAR',
      },
    });
    expect(
      await errorDe(pagos.eliminar(PAGO, 'otra vez', ADMIN)),
    ).toMatchObject({
      status: 404,
      code: 'PAGO_NO_EXISTE',
    });
  });

  it('motivo corto ⇒ 400; sin migración ⇒ 503', async () => {
    const { pagos } = mundo({ pagos: [pagoFila()] });
    expect((await errorDe(pagos.eliminar(PAGO, 'ups', ADMIN))).code).toBe(
      'MOTIVO_INVALIDO',
    );
    const sin = mundo({ sinMigracion: true });
    expect(
      (await errorDe(sin.pagos.eliminar(PAGO, 'Capturado dos veces', ADMIN)))
        .status,
    ).toBe(503);
  });
});

describe('RepartoPagoService — quién corrigió (bitácora)', () => {
  const PAGO = 'dddddddd-0000-4000-8000-000000000001';

  it('TODA escritura sobre una entrega sella updated_by (el trigger reparto_bitacora lo toma como actor); el panel recibe updated_by_nombre', async () => {
    const { pagos, escrituras } = mundo({ pagos: [pagoFila()] });
    const r = await pagos.actualizar(PAGO, { monto: 700 }, MARY_FACT);
    expect(r.pago).toMatchObject({
      updated_by: MARY,
      updated_by_nombre: 'Mary Cruz',
    });
    await pagos.subirComprobante(
      PAGO,
      {
        buffer: Buffer.alloc(10, 1),
        nombre: 'spei.pdf',
        mime: 'application/pdf',
      },
      ADMIN,
    );
    await pagos.eliminar(PAGO, 'Capturado dos veces', MARY_FACT);
    const upd = escrituras.filter(
      (e) => e.tabla === 'reparto_pago' && e.op === 'update',
    );
    expect(upd.map((e) => e.valor.updated_by)).toEqual([MARY, ALE, MARY]);
  });
});

describe('RepartoPagoService.subirComprobante', () => {
  const PAGO = 'dddddddd-0000-4000-8000-000000000001';
  const pdf = (bytes = 100) => ({
    buffer: Buffer.alloc(bytes, 1),
    nombre: 'spei.pdf',
    mime: 'application/pdf',
  });

  it('sube a <socio>/<entrega>/<uuid>.pdf, guarda el path y firma 8 h; reemplazar CONSERVA el anterior', async () => {
    const { pagos, tablas, removidos } = mundo({ pagos: [pagoFila()] });
    const r1 = await pagos.subirComprobante(PAGO, pdf(), ADMIN);
    const p1 = String(tablas.reparto_pago[0].comprobante_path);
    expect(p1).toMatch(new RegExp(`^${MAURICIO}/${PAGO}/[0-9a-f-]{36}\\.pdf$`));
    expect(r1.pago.comprobante_url).toBe(
      `https://firmada/reparto-comprobantes/${p1}?exp=28800`,
    );
    await pagos.subirComprobante(PAGO, pdf(), ADMIN);
    expect(tablas.reparto_pago[0].comprobante_path).not.toBe(p1);
    expect(removidos).toEqual([]);
  });

  it('tipo inválido ⇒ 400; más de 10 MB ⇒ 413; entrega borrada ⇒ 404', async () => {
    const { pagos } = mundo({
      pagos: [pagoFila({ deleted_at: '2026-10-01T16:00:00Z' })],
    });
    expect(
      (
        await errorDe(
          pagos.subirComprobante(
            PAGO,
            { ...pdf(), nombre: 'x.exe', mime: 'application/x-msdownload' },
            ADMIN,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await errorDe(
          pagos.subirComprobante(PAGO, pdf(10 * 1024 * 1024 + 1), ADMIN),
        )
      ).status,
    ).toBe(413);
    expect(
      (await errorDe(pagos.subirComprobante(PAGO, pdf(), ADMIN))).code,
    ).toBe('PAGO_NO_EXISTE');
  });
});

describe('RepartoPagoService.listar', () => {
  it('por fecha de entrega (más reciente primero), sin borradas, con nombres, avión y comprobante firmado', async () => {
    const { pagos } = mundo({
      pagos: [
        pagoFila({
          id: 'p-1',
          fecha_pago: '2026-09-15',
          comprobante_path: 'a/b/c.pdf',
        }),
        pagoFila({
          id: 'p-2',
          fecha_pago: '2026-10-01',
          socio_id: AERO,
          aeronave_id: null,
          periodo: null,
        }),
        pagoFila({
          id: 'p-3',
          fecha_pago: '2026-09-20',
          deleted_at: '2026-10-01T00:00:00Z',
        }),
        pagoFila({ id: 'p-4', fecha_pago: '2026-08-31' }),
      ],
    });
    const r = await pagos.listar(
      { desde: '2026-09-01', hasta: '2026-10-31' },
      ADMIN,
    );
    expect(r.disponible).toBe(true);
    expect(r.pagos.map((p) => p.id)).toEqual(['p-2', 'p-1']);
    expect(r.pagos[1]).toMatchObject({
      entregado_por_nombre: 'Mary Cruz',
      aeronave: { id: N4142R, matricula: 'N4142R' },
      comprobante_url:
        'https://firmada/reparto-comprobantes/a/b/c.pdf?exp=28800',
    });
    const solo = await pagos.listar({ socio_id: AERO }, ADMIN);
    expect(solo.pagos.map((p) => p.id)).toEqual(['p-2']);
  });

  it('SOCIO: solo las suyas (la consulta ya filtra); pedir otro socio ⇒ 403', async () => {
    const { pagos } = mundo({
      pagos: [pagoFila({ id: 'p-1' }), pagoFila({ id: 'p-2', socio_id: AERO })],
    });
    const socio = { userId: MAURICIO, rol: Rol.SOCIO };
    expect((await pagos.listar({}, socio)).pagos.map((p) => p.id)).toEqual([
      'p-1',
    ]);
    expect(
      await errorDe(pagos.listar({ socio_id: AERO }, socio)),
    ).toMatchObject({
      status: 403,
      code: 'SOCIO_SOLO_SU_CUENTA',
    });
  });

  it('?mes= / ?aeronave_id= (v1) ⇒ 410 PAGOS_POR_MES_RETIRADO; rango invertido ⇒ 400; sin migración ⇒ disponible:false', async () => {
    const { pagos } = mundo();
    for (const q of [
      { mes: '2026-09' },
      { mes: '2026-09', aeronave_id: 'avion-n4142r' },
      { aeronave_id: 'avion-n4142r' },
    ]) {
      expect(await errorDe(pagos.listar(q, ADMIN))).toMatchObject({
        status: 410,
        code: 'PAGOS_POR_MES_RETIRADO',
      });
    }
    expect(
      await errorDe(
        pagos.listar({ desde: '2026-10-02', hasta: '2026-10-01' }, ADMIN),
      ),
    ).toMatchObject({ status: 400, code: 'RANGO_INVALIDO' });
    const sin = mundo({ sinMigracion: true });
    expect(await sin.pagos.listar({}, ADMIN)).toEqual({
      disponible: false,
      pagos: [],
    });
  });
});
