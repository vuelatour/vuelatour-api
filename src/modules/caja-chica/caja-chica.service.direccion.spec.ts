import { ForbiddenException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import { CODIGO_CAJA_SOLO_DIRECCION } from '../../common/roles.util';
import { CajaChicaService } from './caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * CAJA CHICA DE DIRECCIÓN (6-nov-2026, invariante 122). Pedido del dueño:
 * Administración «no puede ver, ni editar la caja chica de dirección». El
 * fondo es de Dirección por el ROL de su dueño (`usuario.rol`): Administración
 * (ADMIN) no lo ve en la lista (ni en el conteo) y recibe 403
 * `CAJA_SOLO_DIRECCION` en el detalle y en toda escritura; Dirección y los
 * demás roles con acceso al módulo siguen igual.
 */
describe('CajaChicaService — caja chica de Dirección', () => {
  type Resultado = {
    data: unknown;
    error: null | { message: string };
    count?: number;
  };

  function consulta(resultado: Resultado) {
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, {
      select: self,
      eq: self,
      in: self,
      is: self,
      not: self,
      order: self,
      limit: self,
      range: self,
      maybeSingle: () => Promise.resolve(resultado),
      then: (
        resolve: (v: Resultado) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(resultado).then(resolve, reject),
    });
    return q;
  }

  const FONDO_ALE = 'f-ale';
  const FONDO_MARY = 'f-mary';
  const fondoAle = {
    id: FONDO_ALE,
    usuario_id: 'u-ale',
    moneda: 'MXN',
    activo: true,
    es_acumulada: true,
    monto_fondo: null,
    fondo_origen_id: null,
    notas: null,
    usuario: { nombre: 'Alejandro Canales', email: 'a@x.mx', rol: 'DIRECCION' },
  };
  const fondoMary = {
    ...fondoAle,
    id: FONDO_MARY,
    usuario_id: 'u-mary',
    es_acumulada: false,
    usuario: { nombre: 'Mary Cruz', email: 'm@x.mx', rol: 'ADMIN' },
  };

  function servicio(tablas: Record<string, Resultado>) {
    const supabase = {
      service: {
        from: (tabla: string) =>
          consulta(tablas[tabla] ?? { data: [], error: null }),
      },
    } as unknown as SupabaseService;
    return new CajaChicaService(supabase);
  }

  const lista = () =>
    servicio({
      caja_chica_fondo: { data: [fondoAle, fondoMary], error: null, count: 2 },
    });

  it('Administración no ve el fondo de Dirección en la lista (y el conteo baja)', async () => {
    const r = await lista().listFondos({ limit: 50, offset: 0 }, Rol.ADMIN);
    expect(r.data.map((f) => f.id)).toEqual([FONDO_MARY]);
    expect(r.count).toBe(1);
  });

  it('Dirección (y FACTURACION/SOCIO, que ya entraban al módulo) ven los dos', async () => {
    for (const rol of [Rol.DIRECCION, Rol.FACTURACION, Rol.SOCIO, undefined]) {
      const r = await lista().listFondos({ limit: 50, offset: 0 }, rol);
      expect(r.data.map((f) => f.id)).toEqual([FONDO_ALE, FONDO_MARY]);
      expect(r.count).toBe(2);
    }
  });

  describe('detalle y escrituras sobre el fondo de Dirección', () => {
    const soloAle = () =>
      servicio({
        caja_chica_fondo: { data: fondoAle, error: null },
        caja_chica_movimiento: {
          data: {
            id: 'm-1',
            fondo_id: FONDO_ALE,
            tipo: 'REPOSICION',
            monto: '100',
            moneda: 'MXN',
            fecha: '2026-11-03',
            espejo_de_id: null,
          },
          error: null,
        },
      });

    const esperar403 = async (p: Promise<unknown>) => {
      await expect(p).rejects.toBeInstanceOf(ForbiddenException);
      await p.catch((e: ForbiddenException) => {
        expect((e.getResponse() as { error?: string }).error).toBe(
          CODIGO_CAJA_SOLO_DIRECCION,
        );
      });
    };

    it('Administración ⇒ 403 CAJA_SOLO_DIRECCION en detalle, fondo, movimientos y Excel', async () => {
      const svc = soloAle();
      await esperar403(svc.getFondoDetail(FONDO_ALE, Rol.ADMIN));
      await esperar403(
        svc.updateFondo(FONDO_ALE, { notas: 'x' }, 'u-mary', Rol.ADMIN),
      );
      await esperar403(
        svc.createMovimiento(
          FONDO_ALE,
          { tipo: 'REPOSICION', monto: 100, fecha: '2026-11-03' } as never,
          'u-mary',
          Rol.ADMIN,
        ),
      );
      await esperar403(
        svc.updateMovimiento('m-1', { notas: 'x' }, 'u-mary', Rol.ADMIN),
      );
      await esperar403(svc.removeMovimiento('m-1', Rol.ADMIN));
      await esperar403(svc.reposicionXlsx('m-1', Rol.ADMIN));
      await esperar403(svc.porReponerXlsx(FONDO_ALE, Rol.ADMIN));
    });

    it('Dirección pasa la veda (lo que falle después ya no es el 403 de Dirección)', async () => {
      const svc = soloAle();
      await expect(
        svc.getFondoDetail(FONDO_ALE, Rol.DIRECCION).catch((e: unknown) => e),
      ).resolves.not.toBeInstanceOf(ForbiddenException);
    });
  });
});
