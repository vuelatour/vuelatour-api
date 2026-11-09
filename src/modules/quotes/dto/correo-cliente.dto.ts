import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Body de `POST /v1/quotes/:id/correo-confirmacion` (9-nov-2026). */
export class EnviarCorreoConfirmacionDto {
  @ApiPropertyOptional({
    description:
      'true = enviar aunque este correo ya se le haya enviado al cliente (sin él: 409 CORREO_YA_ENVIADO).',
  })
  @IsOptional()
  @IsBoolean()
  reenviar?: boolean;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Query de `GET /v1/quotes/correos` (días en hora Cancún). */
export class ListCorreosClienteQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hasta − 90 días)' })
  @IsOptional()
  @Matches(DIA, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({
    description: 'YYYY-MM-DD (default: hoy, hora Cancún)',
  })
  @IsOptional()
  @Matches(DIA, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional({ description: '1–500 (default 200)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limite?: number;
}
