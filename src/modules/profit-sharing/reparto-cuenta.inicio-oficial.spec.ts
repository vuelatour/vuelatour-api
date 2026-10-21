// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): la
// cuenta del socio no arranca antes del mes del inicio (400
// CUENTA_ANTES_DEL_INICIO) y el estado de cuenta sube su `desde`.
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./reparto-cuenta.util', () => {
  const real = jest.requireActual<Record<string, unknown>>(
    './reparto-cuenta.util',
  );
  return {
    ...real,
    armarEstadoCuenta: jest.fn((e: { desde: string; hasta: string }) => ({
      desde: e.desde,
      hasta: e.hasta,
    })),
  };
});

import { HttpException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import { RepartoCuentaService } from './reparto-cuenta.service';
import {
  mensajeCuentaAntesDelInicio,
  validarCuentaDesde,
} from './reparto-cuenta.util';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const ACTOR = { userId: 'admin', rol: Rol.ADMIN };

describe('validarCuentaDesde — inicio oficial', () => {
  it('mes anterior al del inicio ⇒ CUENTA_ANTES_DEL_INICIO con details', () => {
    const v = validarCuentaDesde('2026-08', '2026-10', INICIO);
    expect(v).toEqual({
      ok: false,
      codigo: 'CUENTA_ANTES_DEL_INICIO',
      mensaje:
        'La cuenta no puede arrancar antes de septiembre de 2026 (inicio oficial).',
      details: { inicio: INICIO },
    });
    expect(validarCuentaDesde('2026-09', '2026-10', INICIO).ok).toBe(true);
  });

  it('sin inicio ⇒ como 0.0.84', () => {
    expect(validarCuentaDesde('2026-08', '2026-10').ok).toBe(true);
    expect(validarCuentaDesde('2026-08', '2026-10', null).ok).toBe(true);
  });

  it('texto con el mes en español', () => {
    expect(mensajeCuentaAntesDelInicio('2026-10-01')).toBe(
      'La cuenta no puede arrancar antes de octubre de 2026 (inicio oficial).',
    );
  });
});

function armar(inicio: string | null, cuentaDesde = '2026-07') {
  const g = supabaseGrabador();
  const svc = new RepartoCuentaService(
    g.supabase,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  svc.ahora = () => new Date('2026-10-16T17:00:00Z');
  Object.defineProperty(svc, 'lector', {
    value: {
      disponible: jest.fn().mockResolvedValue(true),
      universo: jest.fn().mockResolvedValue({ entregas: [] }),
      sociosAeronave: jest.fn().mockResolvedValue([{ socio_id: 's1' }]),
    },
  });
  Object.assign(svc as unknown as Record<string, unknown>, {
    sociosBase: () => [
      { socio: { id: 's1' }, cuenta: { cuenta_desde: cuentaDesde } },
    ],
    utilidadesDesde: jest.fn().mockResolvedValue([]),
    entregasDe: jest.fn().mockResolvedValue([]),
    assertDisponible: jest.fn().mockResolvedValue(undefined),
  });
  return { svc, ...g };
}

describe('RepartoCuentaService — inicio oficial', () => {
  it('estado de cuenta: desde anterior sube al mes del inicio (eco)', async () => {
    const r = (await armar(INICIO).svc.estadoDeCuenta(
      's1',
      { desde: '2026-07' },
      ACTOR,
    )) as { desde: string; hasta: string };
    expect(r.desde).toBe('2026-09');
    expect(r.hasta).toBe('2026-10');
    // Default = arranque de la cuenta (julio) ⇒ también sube.
    const d = (await armar(INICIO).svc.estadoDeCuenta('s1', {}, ACTOR)) as {
      desde: string;
    };
    expect(d.desde).toBe('2026-09');
  });

  it('estado de cuenta de agosto completo ⇒ el mes del inicio (sin 400)', async () => {
    const r = (await armar(INICIO).svc.estadoDeCuenta(
      's1',
      { desde: '2026-08', hasta: '2026-08' },
      ACTOR,
    )) as { desde: string; hasta: string };
    expect(r).toEqual({ disponible: true, desde: '2026-09', hasta: '2026-09' });
  });

  it('inicio null ⇒ el periodo pedido', async () => {
    const r = (await armar(null).svc.estadoDeCuenta(
      's1',
      { desde: '2026-07' },
      ACTOR,
    )) as { desde: string };
    expect(r.desde).toBe('2026-07');
  });

  it('configurar cuenta en agosto ⇒ 400 CUENTA_ANTES_DEL_INICIO', async () => {
    try {
      // El saldo inicial va EN PESOS desde el 0.0.101 (invariante 99).
      await armar(INICIO).svc.configurarCuenta(
        's1',
        { cuenta_desde: '2026-08', saldo_inicial_mxn: 0 },
        ACTOR,
      );
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const body = (e as HttpException).getResponse() as {
        error: string;
        details: { inicio: string };
      };
      expect(body.error).toBe('CUENTA_ANTES_DEL_INICIO');
      expect(body.details).toEqual({ inicio: INICIO });
    }
  });
});
