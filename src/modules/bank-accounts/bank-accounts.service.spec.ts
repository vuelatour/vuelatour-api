import { BankAccountsService, opcionDeCuenta } from './bank-accounts.service';
import { Moneda, RazonSocialEmisora } from './dto/bank-accounts.dto';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Cuenta de donde salió el pago (20-oct-2026, invariante 98): el selector del
 * gasto lee OPCIONES sin número ni CLABE, y el alta de un alias repetido
 * responde 409 CUENTA_ALIAS_DUPLICADO con la que ya existe.
 */
describe('BankAccountsService — opciones y alias duplicado (invariante 98)', () => {
  it('opcionDeCuenta: solo la terminación, nunca el número completo', () => {
    expect(
      opcionDeCuenta({
        id: 'c1',
        alias: 'American Express Ale',
        banco: 'American Express',
        moneda: 'MXN',
        tipo: 'BANCO',
        razon_social: 'OTRA',
        activa: true,
        numero_cuenta: '3782-822463-12006',
        clabe: '012180001234567891',
      }),
    ).toEqual({
      id: 'c1',
      alias: 'American Express Ale',
      banco: 'American Express',
      moneda: 'MXN',
      tipo: 'BANCO',
      razon_social: 'OTRA',
      activa: true,
      terminacion: '2006',
    });
    expect(
      opcionDeCuenta({ id: 'c2', alias: 'Paywise', tipo: 'PASARELA' }),
    ).toMatchObject({ terminacion: null, tipo: 'PASARELA', activa: true });
  });

  it('opciones(): filtra activas por defecto y no pide CLABE', async () => {
    const llamadas: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'eq']) {
      q[m] = (...a: unknown[]) => {
        llamadas.push([m, a]);
        return q;
      };
    }
    q.then = (r: (v: unknown) => unknown) =>
      Promise.resolve({
        data: [{ id: 'c1', alias: 'HSBC Pesos', activa: true }],
        error: null,
      }).then(r);
    const service = new BankAccountsService({
      service: { from: () => q },
    } as unknown as SupabaseService);
    const r = await service.opciones();
    expect(r.data).toHaveLength(1);
    const select = llamadas.find(([m]) => m === 'select')?.[1][0] as string;
    expect(select).not.toContain('clabe');
    expect(llamadas).toContainEqual(['eq', ['activa', true]]);
  });

  it('alta con alias repetido ⇒ 409 CUENTA_ALIAS_DUPLICADO con la existente', async () => {
    let llamada = 0;
    const q: Record<string, unknown> = {};
    for (const m of ['insert', 'select', 'eq']) q[m] = () => q;
    q.maybeSingle = () => {
      llamada += 1;
      return Promise.resolve(
        llamada === 1
          ? { data: null, error: { code: '23505', message: 'dup' } }
          : {
              data: { id: 'c-hsbc', alias: 'HSBC Pesos', activa: true },
              error: null,
            },
      );
    };
    const service = new BankAccountsService({
      service: { from: () => q },
    } as unknown as SupabaseService);
    await expect(
      service.create(
        {
          alias: 'HSBC Pesos',
          banco: 'HSBC',
          moneda: Moneda.MXN,
          razon_social: RazonSocialEmisora.AEROCHARTER,
        },
        'u',
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'CUENTA_ALIAS_DUPLICADO',
        message:
          'Ya existe una cuenta con el nombre «HSBC Pesos»: elígela de la lista.',
        details: { id: 'c-hsbc', activa: true },
      },
    });
  });
});
