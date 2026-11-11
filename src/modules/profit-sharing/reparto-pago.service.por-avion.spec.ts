// Las utilidades salen de ProfitSharingService.utilidadesSociosPorMes (aquí
// un doble): el servicio real arrastra pyservices/tipo de cambio/conciliación.
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { Rol } from '../../common/types/auth.types';
import type { CrearPagoSocioDto } from './dto/reparto-pago.dto';
import {
  ALE,
  KEY,
  MAURICIO,
  N4142R,
  N990GG,
  avionN4142R,
  errorDe,
  mundo,
  pagoFila,
} from './reparto-cuenta.fixture-spec';
import type { RepartoAvionInput } from './reparto-cuenta.util';

/**
 * EL CANDADO DEL ADELANTO SE MIDE POR AVIÓN (10-nov-2026, API 0.0.134,
 * invariante 129). Reclamo del cliente (cuenta de Mauricio Roque, N4142R y
 * XB-ANU): «le hice una entrega del N4142R… pero el cálculo lo está haciendo
 * con las cuentas del XB-ANU». El saldo único restaba la pérdida de un avión
 * de lo por entregar del otro, así que entregar EXACTAMENTE la utilidad del
 * N4142R pedía confirmar un «adelanto» que no existía.
 *
 * Mundo: Mauricio generó $1,395.94 en septiembre con el N4142R y su otro
 * avión (N990GG) PERDIÓ $500 ese mes. Toda la cuenta: $895.94 por entregar.
 */
const ADMIN = { userId: ALE, rol: Rol.ADMIN };

/** N990GG en septiembre: Mauricio con una PÉRDIDA de $500. */
function perdidaN990GG(): RepartoAvionInput {
  return {
    aeronave: { id: N990GG, matricula: 'N990GG', modelo: 'Piper' },
    reparto: [
      {
        socio_id: MAURICIO,
        socio_nombre: 'Mauricio Roque',
        porcentaje: 50,
        monto_mxn: -500,
      },
    ],
  };
}

const DOS_AVIONES = { '2026-09': [avionN4142R(), perdidaN990GG()] };

function dtoAlta(p: Partial<CrearPagoSocioDto> = {}): CrearPagoSocioDto {
  return {
    socio_id: MAURICIO,
    monto: 1395.94,
    moneda: 'MXN',
    tc_usd_mxn: 18.5,
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    ...p,
  };
}

describe('RepartoPagoService.crear — saldo por avión', () => {
  it('entregar EXACTAMENTE lo del N4142R no pide confirmar aunque su otro avión tenga pérdida; el snapshot guarda el saldo de ESE avión', async () => {
    const { pagos, tablas } = mundo({ utilidades: DOS_AVIONES });
    const r = await pagos.crear(
      dtoAlta({ aeronave_id: N4142R, mes: '2026-09', client_request_id: KEY }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toEqual([
      expect.objectContaining({
        aeronave_id: N4142R,
        monto_mxn: 1395.94,
        // Contra lo que se decidió: el saldo del N4142R, no los $895.94 de
        // toda la cuenta.
        saldo_snapshot_mxn: 1395.94,
      }),
    ]);
    expect(r.cuenta.cuenta_por_avion).toBe(true);
    expect(
      r.cuenta.por_avion.map((s) => [
        s.aeronave?.matricula ?? null,
        s.por_entregar_mxn,
      ]),
    ).toEqual([
      ['N4142R', 0],
      ['N990GG', -500],
    ]);
    // Los totales del socio siguen siendo la suma de sus aviones.
    expect(r.cuenta).toMatchObject({
      generado_mxn: 895.94,
      entregado_mxn: 1395.94,
      por_entregar_mxn: -500,
    });
  });

  it('pasarse del saldo del avión SÍ pide confirmar, y el 409 nombra el avión', async () => {
    const { pagos, tablas } = mundo({ utilidades: DOS_AVIONES });
    expect(
      await errorDe(
        pagos.crear(dtoAlta({ monto: 1500, aeronave_id: N4142R }), ADMIN),
      ),
    ).toEqual({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      message:
        'Esta entrega de $1,500 MXN supera lo que hay por entregar de N4142R ($1,395.94 MXN). Se registrará como ADELANTO y el saldo de N4142R quedará a favor de VuelaTour por $104.06 MXN. ¿Registrar?',
      details: {
        por_entregar_mxn: 1395.94,
        mes_en_curso_mxn: 0,
        monto_mxn: 1500,
        exceso_mxn: 104.06,
        saldo_despues_mxn: -104.06,
        aeronave: { id: N4142R, matricula: 'N4142R' },
        adelantado_general_mxn: 0,
      },
    });
    expect(tablas.reparto_pago).toHaveLength(0);
    // Confirmado, se guarda como adelanto de ESE avión.
    const r = await pagos.crear(
      dtoAlta({ monto: 1500, aeronave_id: N4142R, aceptar_exceso: true }),
      ADMIN,
    );
    expect(r.cuenta.por_avion[0]).toMatchObject({
      por_entregar_mxn: -104.06,
      estado: 'ADELANTADO',
    });
  });

  it('una entrega al avión con pérdida pide confirmar (su saldo es negativo)', async () => {
    const { pagos } = mundo({ utilidades: DOS_AVIONES });
    expect(
      await errorDe(
        pagos.crear(dtoAlta({ monto: 100, aeronave_id: N990GG }), ADMIN),
      ),
    ).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      details: {
        por_entregar_mxn: -500,
        aeronave: { id: N990GG, matricula: 'N990GG' },
      },
    });
  });

  it('SIN avión se mide contra toda la cuenta ($895.94), como siempre', async () => {
    const { pagos, tablas } = mundo({ utilidades: DOS_AVIONES });
    expect(await errorDe(pagos.crear(dtoAlta({ monto: 1000 }), ADMIN))).toEqual(
      {
        status: 409,
        code: 'PAGO_EXCEDE_SALDO',
        message:
          'Esta entrega de $1,000 MXN supera lo que hay por entregar ($895.94 MXN). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $104.06 MXN. ¿Registrar?',
        details: {
          por_entregar_mxn: 895.94,
          mes_en_curso_mxn: 0,
          monto_mxn: 1000,
          exceso_mxn: 104.06,
          saldo_despues_mxn: -104.06,
          aeronave: null,
          adelantado_general_mxn: 0,
        },
      },
    );
    await pagos.crear(dtoAlta({ monto: 895.94 }), ADMIN);
    expect(tablas.reparto_pago).toHaveLength(1);
  });

  it('lo ya entregado «a cuenta» (sin avión) se le descuenta al avión: no se entrega dos veces', async () => {
    const { pagos } = mundo({
      utilidades: DOS_AVIONES,
      pagos: [pagoFila({ monto: 400, aeronave_id: null, periodo: null })],
    });
    expect(
      await errorDe(
        pagos.crear(dtoAlta({ monto: 1395.94, aeronave_id: N4142R }), ADMIN),
      ),
    ).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      details: {
        // 1,395.94 del avión − 400 ya adelantados a cuenta general.
        por_entregar_mxn: 995.94,
        exceso_mxn: 400,
        aeronave: { id: N4142R, matricula: 'N4142R' },
        adelantado_general_mxn: 400,
      },
    });
    const r = await pagos.crear(
      dtoAlta({ monto: 995.94, aeronave_id: N4142R }),
      ADMIN,
    );
    expect(
      r.cuenta.por_avion.map((s) => s.aeronave?.matricula ?? null),
    ).toEqual(['N4142R', 'N990GG', null]);
  });
});

describe('RepartoPagoService.actualizar — saldo por avión', () => {
  const PAGO = 'dddddddd-0000-4000-8000-000000000001';

  it('subir el monto se mide contra el saldo del avión SIN esta entrega; pasarse nombra el avión', async () => {
    const { pagos, tablas } = mundo({
      utilidades: DOS_AVIONES,
      pagos: [pagoFila({ monto: 1000 })], // N4142R, corresponde a septiembre
    });
    // Hasta el saldo del avión (1,395.94): pasa sin confirmar, aunque toda
    // la cuenta solo tenga 895.94.
    await pagos.actualizar(PAGO, { monto: 1395.94 }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      monto_mxn: 1395.94,
      saldo_snapshot_mxn: 1395.94,
    });
    expect(
      await errorDe(pagos.actualizar(PAGO, { monto: 1500 }, ADMIN)),
    ).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      message:
        'Esta entrega de $1,500 MXN supera lo que hay por entregar de N4142R ($1,395.94 MXN). Se registrará como ADELANTO y el saldo de N4142R quedará a favor de VuelaTour por $104.06 MXN. ¿Registrar?',
      details: {
        por_entregar_mxn: 1395.94,
        aeronave: { id: N4142R, matricula: 'N4142R' },
      },
    });
  });

  it('pasar la entrega a «sin avión» y subirla se mide contra toda la cuenta', async () => {
    const { pagos } = mundo({
      utilidades: DOS_AVIONES,
      pagos: [pagoFila({ monto: 500 })],
    });
    expect(
      await errorDe(
        pagos.actualizar(PAGO, { monto: 1000, aeronave_id: null }, ADMIN),
      ),
    ).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_SALDO',
      details: { por_entregar_mxn: 895.94, aeronave: null },
    });
  });
});
