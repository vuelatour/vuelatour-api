import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelGrupoDto {
  @ApiProperty({ description: 'Motivo (queda en cada hijo y en la cabecera).' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;
}

export class FechaGrupoDto {
  @ApiProperty({
    description:
      'Nueva salida del grupo (ISO). Cada hijo conserva su desfase escalonado.',
  })
  @Type(() => Date)
  @IsDate()
  fecha_vuelo!: Date;
}

export class QuitarAvionDto {
  @ApiPropertyOptional({
    description: 'Motivo de la baja del avión (default: "Quitado del grupo").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}

export class ReemplazarAvionDto {
  @ApiProperty({ description: 'Aeronave nueva.' })
  @IsUUID()
  aeronave_id!: string;

  @ApiPropertyOptional({
    description: 'Piloto para el avión nuevo (opcional).',
  })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiProperty({
    enum: ['SIMPLE', 'ULTIMO_MINUTO'],
    description:
      'SIMPLE = cambio de avión en el mismo vuelo (flights.assign, blanket selectivo a tramos). ULTIMO_MINUTO = reassign-aircraft (clona el vuelo; el original queda cancelado; el clon conserva la liga y el ancla).',
  })
  @IsIn(['SIMPLE', 'ULTIMO_MINUTO'])
  modo!: 'SIMPLE' | 'ULTIMO_MINUTO';

  @ApiProperty({
    description:
      'Recotizar el hijo con el avión nuevo (tarifa/velocidad/prefijo TUAS). Solo si no está cobrado/facturado; si lo está, el precio se conserva y queda la bandera precio_desactualizado.',
  })
  @IsBoolean()
  recotizar!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}
