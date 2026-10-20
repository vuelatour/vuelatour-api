import { ConflictException } from '@nestjs/common';
import {
  ProvidersService,
  normalizarNombreProveedor,
} from './providers.service';
import { TipoProveedor } from './dto/providers.dto';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Proveedor en línea desde el gasto (20-oct-2026, invariante 98): un nombre
 * que ya usa OTRO proveedor activo responde 409 PROVEEDOR_DUPLICADO con el
 * existente (sin acentos, mayúsculas ni signos), en el alta y al renombrar.
 */
function armar(existentes: Array<{ id: string; nombre: string }>) {
  const escrituras: unknown[] = [];
  const supabase = {
    service: {
      from: () => {
        let op: 'select' | 'insert' | 'update' = 'select';
        let cuerpo: Record<string, unknown> = {};
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'limit', 'order', 'range', 'or']) {
          q[m] = () => q;
        }
        q.insert = (c: Record<string, unknown>) => {
          op = 'insert';
          cuerpo = c;
          escrituras.push(c);
          return q;
        };
        q.update = (c: Record<string, unknown>) => {
          op = 'update';
          cuerpo = c;
          escrituras.push(c);
          return q;
        };
        q.maybeSingle = () =>
          Promise.resolve({
            data: op === 'select' ? null : { id: 'p-nuevo', ...cuerpo },
            error: null,
          });
        q.then = (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: existentes, error: null }).then(r);
        return q;
      },
    },
  } as unknown as SupabaseService;
  return { service: new ProvidersService(supabase), escrituras };
}

describe('ProvidersService — nombre duplicado (invariante 98)', () => {
  it('normaliza acentos, mayúsculas y signos', () => {
    expect(normalizarNombreProveedor('  Gasolinera Álamo, S.A.  ')).toBe(
      'gasolinera alamo s a',
    );
    expect(normalizarNombreProveedor('GASOLINERA ALAMO S A')).toBe(
      'gasolinera alamo s a',
    );
  });

  it('alta con un nombre que ya existe ⇒ 409 PROVEEDOR_DUPLICADO con el existente, sin escribir', async () => {
    const { service, escrituras } = armar([
      { id: 'p-1', nombre: 'Aeropuertos del Sureste (ASUR)' },
    ]);
    await expect(
      service.create(
        {
          nombre: 'aeropuertos del sureste asur',
          tipo: TipoProveedor.NACIONAL,
        },
        'u',
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'PROVEEDOR_DUPLICADO',
        message:
          'Ya existe el proveedor «Aeropuertos del Sureste (ASUR)»: elígelo de la lista.',
        details: { id: 'p-1', nombre: 'Aeropuertos del Sureste (ASUR)' },
      },
    });
    expect(escrituras).toHaveLength(0);
  });

  it('alta con nombre libre: se guarda', async () => {
    const { service, escrituras } = armar([{ id: 'p-1', nombre: 'ASUR' }]);
    const r = await service.create(
      { nombre: 'Estafeta', tipo: TipoProveedor.NACIONAL },
      'u',
    );
    expect(r).toMatchObject({ nombre: 'Estafeta' });
    expect(escrituras).toHaveLength(1);
  });

  it('renombrar: choca con OTRO, no consigo mismo', async () => {
    const { service } = armar([
      { id: 'p-1', nombre: 'Estafeta' },
      { id: 'p-2', nombre: 'DHL' },
    ]);
    await expect(
      service.update('p-2', { nombre: 'estafeta' }, 'u'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update('p-1', { nombre: 'ESTAFETA' }, 'u'),
    ).resolves.toMatchObject({ nombre: 'ESTAFETA' });
  });
});
