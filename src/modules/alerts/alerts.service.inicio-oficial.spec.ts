// INICIO OFICIAL (16-oct-2026, invariante 86): piso en `vuelo_estancado`,
// `cobro_pendiente` y `gastos_sin_avion`; las de SALDO no se tocan.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { AlertsService, type AlertConfig } from './alerts.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const CORTE = '2026-09-01T00:00:00-05:00';

const config: AlertConfig = {
  clave: 'x',
  descripcion: 'x',
  activa: true,
  canal: 'socket',
  roles: ['ADMIN'],
  dias_anticipacion: [3],
  horas_anticipacion: null,
};

type Priv = Record<string, (c: AlertConfig) => Promise<void>>;

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const cfg = cfgInicio(inicio);
  const svc = new AlertsService(
    g.supabase,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cfg as unknown as ConfiguracionService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    dispatch: jest.fn().mockResolvedValue(undefined),
  });
  return { svc, priv: svc as unknown as Priv, cfg, ...g };
}

describe('AlertsService — inicio oficial', () => {
  it('vuelo_estancado: pre-vuelo por fecha_vuelo y EN_VUELO por fecha_fin', async () => {
    const { priv, de, lleva } = armar(INICIO);
    await priv.checkVuelosEstancados(config);
    const [enVuelo, preVuelo] = de('vuelo');
    expect(lleva(enVuelo, 'gte', 'fecha_fin', CORTE)).toBe(true);
    expect(lleva(preVuelo, 'gte', 'fecha_vuelo', CORTE)).toBe(true);
  });

  it('cobro_pendiente: por fecha_vuelo (no por updated_at)', async () => {
    const { priv, de, lleva } = armar(INICIO);
    await priv.checkCobrosPendientes(config);
    expect(lleva(de('vuelo')[0], 'gte', 'fecha_vuelo', CORTE)).toBe(true);
  });

  it('gastos_sin_avion: mismo universo que la bandeja', async () => {
    const { priv, de, lleva } = armar(INICIO);
    await priv.checkGastosSinAvion(config);
    expect(lleva(de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
  });

  it('gastos_sin_avion: «Otros movimientos (VuelaTour)» (23-oct-2026, invariante 107) queda FUERA del universo (el not.in de la fuente única)', async () => {
    const { priv, de } = armar(INICIO);
    await priv.checkGastosSinAvion(config);
    const notIn = de('gasto')
      .flatMap((c) => c.ops)
      .find((o) => o.m === 'not' && o.args[0] === 'categoria')?.args[2];
    expect(typeof notIn).toBe('string');
    expect(notIn).toContain('OTROS_MOVIMIENTOS');
    expect(notIn).toContain('COMISION_VENDEDOR');
    expect(notIn).not.toContain('COMISION_VENDEDOR_AVION');
  });

  it('inicio null ⇒ sin piso (como 0.0.83)', async () => {
    const { priv, consultas } = armar(null);
    await priv.checkVuelosEstancados(config);
    await priv.checkCobrosPendientes(config);
    await priv.checkGastosSinAvion(config);
    for (const c of consultas) {
      expect(
        c.ops.some(
          (o) =>
            o.m === 'gte' &&
            ['fecha_vuelo', 'fecha_fin', 'fecha_gasto'].includes(
              o.args[0] as string,
            ),
        ),
      ).toBe(false);
    }
  });

  it('caja_negativa e inventario_bajo (saldos) no consultan el inicio', async () => {
    const { priv, cfg } = armar(INICIO);
    await priv.checkCajaNegativa?.(config).catch(() => undefined);
    await priv.checkInventarioBajo?.(config).catch(() => undefined);
    expect(cfg.inicioOficial).not.toHaveBeenCalled();
  });
});
