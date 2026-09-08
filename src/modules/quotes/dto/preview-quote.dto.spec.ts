import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PreviewQuoteDto } from './preview-quote.dto';

/**
 * Body de POST /quotes/preview-html: con quote_id + sucio=false el motor no
 * corre y los obligatorios de CalculateQuoteDto se relajan (ValidateIf
 * registrado programáticamente); en cualquier otro caso siguen exigiéndose.
 * Misma configuración del ValidationPipe de main.ts (whitelist +
 * forbidNonWhitelisted + conversión implícita).
 */
const OPTS = {
  whitelist: true,
  forbidNonWhitelisted: true,
} as const;

function dto(plain: Record<string, unknown>): PreviewQuoteDto {
  return plainToInstance(PreviewQuoteDto, plain, {
    enableImplicitConversion: true,
  });
}

const QUOTE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('PreviewQuoteDto', () => {
  it('LIMPIA (quote_id + sucio=false): pasa sin los campos del motor', async () => {
    const errores = await validate(
      dto({ quote_id: QUOTE_ID, sucio: false }),
      OPTS,
    );
    expect(errores).toEqual([]);
  });

  it("sucio 'false' (string) se convierte a false y no exige el motor", async () => {
    const d = dto({ quote_id: QUOTE_ID, sucio: 'false' });
    expect(d.sucio).toBe(false);
    expect(await validate(d, OPTS)).toEqual([]);
  });

  it('SUCIA (default) exige los obligatorios del motor aunque venga quote_id', async () => {
    const errores = await validate(dto({ quote_id: QUOTE_ID }), OPTS);
    const props = errores.map((e) => e.property);
    expect(props).toEqual(
      expect.arrayContaining([
        'aeronave_id',
        'metodo_pago',
        'pasajeros',
        'tipo_tarifa',
      ]),
    );
  });

  it('sucio=false SIN quote_id sigue exigiendo el motor', async () => {
    const errores = await validate(dto({ sucio: false }), OPTS);
    expect(errores.map((e) => e.property)).toContain('aeronave_id');
  });

  it('escalas_pdf valida orden ≥ 1 y pdf_fecha YYYY-MM-DD (null permitido); campos desconocidos → error', async () => {
    const ok = dto({
      quote_id: QUOTE_ID,
      sucio: false,
      escalas_pdf: [
        { orden: 1, pdf_oculto: true, pdf_fecha: null },
        { orden: 2, pdf_fecha: '2026-09-06' },
      ],
      notas: 'Hola',
      pdf_mostrar_tarifa: true,
      fecha_traslado_inicial: '2026-09-12T13:00:00Z',
    });
    expect(await validate(ok, OPTS)).toEqual([]);
    expect(ok.fecha_traslado_inicial).toBeInstanceOf(Date);
    expect(ok.escalas_pdf?.[1].pdf_fecha).toBe('2026-09-06');

    const mal = dto({
      quote_id: QUOTE_ID,
      sucio: false,
      escalas_pdf: [{ orden: 0, pdf_fecha: '06/09/2026' }],
    });
    const errores = await validate(mal, OPTS);
    expect(errores.map((e) => e.property)).toEqual(['escalas_pdf']);

    const desconocido = dto({ quote_id: QUOTE_ID, sucio: false, foo: 1 });
    expect((await validate(desconocido, OPTS)).map((e) => e.property)).toEqual([
      'foo',
    ]);
  });
});
