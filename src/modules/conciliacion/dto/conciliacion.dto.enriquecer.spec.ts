import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImportarMovimientosDto } from './conciliacion.dto';

/**
 * CONCEPTO DEL SPEI (13-oct-2026, API 0.0.75, invariante 69):
 * `solo_enriquecer` es ADITIVO y opcional. Misma configuración del
 * ValidationPipe de main.ts (whitelist + forbidNonWhitelisted + conversión
 * implícita): un «"si"» NO se convierte en `true` en silencio.
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
const CTA = 'aaaaaaaa-0000-4000-8000-000000000001';
const MOV = {
  fecha: '2026-09-07',
  tipo: 'CARGO',
  monto: 1118.12,
  descripcion: 'SEL TRANSF. INTERBANCARIA SPEI BANORTE fact vip 7350',
};

function dto(extra: Record<string, unknown>): ImportarMovimientosDto {
  return plainToInstance(
    ImportarMovimientosDto,
    { cuenta_bancaria_id: CTA, movimientos: [MOV], ...extra },
    { enableImplicitConversion: true },
  );
}

async function props(extra: Record<string, unknown>): Promise<string[]> {
  return (await validate(dto(extra), OPTS)).map((e) => e.property);
}

describe('ImportarMovimientosDto — solo_enriquecer', () => {
  it('sin el campo (panel de siempre) pasa igual', async () => {
    const d = dto({});
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.solo_enriquecer).toBeUndefined();
  });

  it('acepta true y false', async () => {
    const si = dto({ solo_enriquecer: true });
    expect(await validate(si, OPTS)).toEqual([]);
    expect(si.solo_enriquecer).toBe(true);
    const no = dto({ solo_enriquecer: false });
    expect(await validate(no, OPTS)).toEqual([]);
    expect(no.solo_enriquecer).toBe(false);
  });

  it('rechaza «si», «true» de texto y números (jamás se adivina)', async () => {
    expect(await props({ solo_enriquecer: 'si' })).toEqual(['solo_enriquecer']);
    expect(await props({ solo_enriquecer: 'true' })).toEqual([
      'solo_enriquecer',
    ]);
    expect(await props({ solo_enriquecer: 1 })).toEqual(['solo_enriquecer']);
  });

  it('la vista previa usa el mismo DTO: sin archivo también pasa', async () => {
    expect(
      await props({ filename: undefined, file_base64: undefined }),
    ).toEqual([]);
  });
});
